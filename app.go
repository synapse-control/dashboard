package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

type app struct {
	cfg   config
	hub   *hubClient
	live  *broadcaster
	users *userStore
	sess  *sessions
	oidc  *oidcLogin
	limit *limiter
	pages map[string]*template.Template
	proxy *httputil.ReverseProxy
}

func newApp(ctx context.Context, cfg config) (*app, error) {
	if !cfg.localLogin && cfg.oidcIssuer == "" {
		return nil, errors.New("DASHBOARD_LOCAL_LOGIN=false needs OIDC_ISSUER, or nobody can sign in")
	}
	if cfg.oidcIssuer != "" && cfg.publicURL == "" {
		return nil, errors.New("OIDC_ISSUER needs SYNAPSE_PUBLIC_URL for the sign-in callback")
	}
	hubURL, err := url.Parse(cfg.hubURL)
	if err != nil || hubURL.Host == "" {
		return nil, fmt.Errorf("SYNAPSE_HUB_URL %q is not a URL", cfg.hubURL)
	}
	if err := os.MkdirAll(cfg.dataDir, 0o700); err != nil {
		return nil, err
	}
	users, err := openUsers(cfg.dataDir)
	if err != nil {
		return nil, err
	}
	key, err := loadKey(cfg.dataDir, "session.key")
	if err != nil {
		return nil, err
	}
	a := &app{
		cfg:   cfg,
		hub:   &hubClient{base: cfg.hubURL, tokenDir: cfg.tokenDir, http: &http.Client{Timeout: 60 * time.Second}},
		live:  newBroadcaster(),
		users: users,
		sess:  &sessions{key: key, secure: strings.HasPrefix(cfg.publicURL, "https://")},
		limit: &limiter{hits: map[string][]time.Time{}},
		pages: map[string]*template.Template{},
		proxy: &httputil.ReverseProxy{Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(hubURL)
			r.SetXForwarded()
		}},
	}
	if cfg.oidcIssuer != "" {
		if a.oidc, err = newOIDC(ctx, cfg); err != nil {
			return nil, fmt.Errorf("OIDC_ISSUER %s: %w", cfg.oidcIssuer, err)
		}
	}
	for _, p := range []string{"login", "setup", "nodes", "node", "add", "users", "error"} {
		a.pages[p] = template.Must(template.ParseFS(webFS, "web/layout.html", "web/"+p+".html"))
	}
	go a.pollLoop(ctx)
	return a, nil
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(webFS, "web/static")
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(static)))
	mux.HandleFunc("GET /health", a.health)
	mux.Handle("/nodes", a.proxy)
	mux.Handle("/mcp/", a.proxy)
	mux.HandleFunc("GET /setup", a.setupPage)
	mux.HandleFunc("POST /setup", a.setupSubmit)
	mux.HandleFunc("GET /login", a.loginPage)
	mux.HandleFunc("POST /login", a.loginSubmit)
	mux.HandleFunc("POST /logout", a.logout)
	mux.HandleFunc("GET /auth/oidc", a.needOIDC(a.oidcStart))
	mux.HandleFunc("GET /auth/callback", a.needOIDC(a.oidcCallback))
	mux.HandleFunc("GET /{$}", a.signedIn(a.nodesPage))
	mux.HandleFunc("GET /node/{name}", a.signedIn(a.nodePage))
	mux.HandleFunc("GET /add", a.signedIn(a.addPage))
	mux.HandleFunc("GET /users", a.admin(a.usersPage))
	mux.HandleFunc("POST /users", a.admin(a.usersAdd))
	mux.HandleFunc("POST /users/{name}/delete", a.admin(a.usersDelete))
	mux.HandleFunc("GET /events", a.signedIn(a.events))
	mux.HandleFunc("POST /api/call/{tool}", a.signedIn(a.apiCall))
	return headers(http.NewCrossOriginProtection().Handler(mux))
}

func headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("content-security-policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		h.Set("x-content-type-options", "nosniff")
		h.Set("referrer-policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

type page struct {
	Title   string
	User    session
	Admin   bool
	Error   string
	OIDC    bool
	Local   bool
	Data    any
	Version string
}

func (a *app) render(w http.ResponseWriter, status int, name string, p page) {
	p.Version = version
	p.Admin = p.User.Role == roleAdmin
	p.OIDC = a.oidc != nil
	p.Local = a.cfg.localLogin
	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	if err := a.pages[name].ExecuteTemplate(w, "layout", p); err != nil {
		log.Printf("render %s: %v", name, err)
	}
}

func (a *app) fail(w http.ResponseWriter, r *http.Request, status int, msg string) {
	s, _ := a.current(r)
	a.render(w, status, "error", page{Title: "Something went wrong", User: s, Error: msg})
}

func (a *app) signedIn(h func(http.ResponseWriter, *http.Request, session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, ok := a.current(r)
		if !ok {
			if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/events" {
				http.Error(w, `{"error":"sign in first"}`, http.StatusUnauthorized)
				return
			}
			if a.cfg.localLogin && a.users.empty() {
				http.Redirect(w, r, "/setup", http.StatusFound)
				return
			}
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		h(w, r, s)
	}
}

func (a *app) admin(h func(http.ResponseWriter, *http.Request, session)) http.HandlerFunc {
	return a.signedIn(func(w http.ResponseWriter, r *http.Request, s session) {
		if s.Role != roleAdmin {
			a.fail(w, r, http.StatusForbidden, "Only an admin can do that.")
			return
		}
		h(w, r, s)
	})
}

func (a *app) needOIDC(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.oidc == nil {
			http.NotFound(w, r)
			return
		}
		h(w, r)
	}
}

func (a *app) health(w http.ResponseWriter, r *http.Request) {
	var s snapshot
	if cur := a.live.current(); cur != nil {
		json.Unmarshal(cur, &s)
	}
	w.Header().Set("content-type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": version, "hub": s.HubOK})
}

func (a *app) setupPage(w http.ResponseWriter, r *http.Request) {
	if !a.cfg.localLogin || !a.users.empty() {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}
	a.render(w, http.StatusOK, "setup", page{Title: "Set up Synapse Control"})
}

func (a *app) setupSubmit(w http.ResponseWriter, r *http.Request) {
	if !a.cfg.localLogin || !a.users.empty() {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}
	name, pass := strings.TrimSpace(r.PostFormValue("name")), r.PostFormValue("password")
	if pass != r.PostFormValue("confirm") {
		a.render(w, http.StatusBadRequest, "setup", page{Title: "Set up Synapse Control", Error: "The two passwords differ."})
		return
	}
	if err := a.users.add(name, pass, roleAdmin, true); err != nil {
		a.render(w, http.StatusBadRequest, "setup", page{Title: "Set up Synapse Control", Error: err.Error()})
		return
	}
	a.sess.start(w, name, roleAdmin, "local", 7*24*time.Hour)
	http.Redirect(w, r, "/add", http.StatusFound)
}

func (a *app) loginPage(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.current(r); ok {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	if a.cfg.localLogin && a.users.empty() {
		http.Redirect(w, r, "/setup", http.StatusFound)
		return
	}
	a.render(w, http.StatusOK, "login", page{Title: "Sign in"})
}

func (a *app) loginSubmit(w http.ResponseWriter, r *http.Request) {
	if !a.cfg.localLogin {
		http.NotFound(w, r)
		return
	}
	ip := clientIP(r)
	if a.limit.blocked(ip) {
		a.render(w, http.StatusTooManyRequests, "login", page{Title: "Sign in", Error: "Too many failed sign-ins. Wait 15 minutes."})
		return
	}
	u, ok := a.users.check(strings.TrimSpace(r.PostFormValue("name")), r.PostFormValue("password"))
	if !ok {
		a.limit.fail(ip)
		a.render(w, http.StatusUnauthorized, "login", page{Title: "Sign in", Error: "Wrong name or password."})
		return
	}
	a.sess.start(w, u.Name, u.Role, "local", 7*24*time.Hour)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (a *app) logout(w http.ResponseWriter, r *http.Request) {
	a.sess.clear(w, sessionCookie)
	http.Redirect(w, r, "/login", http.StatusFound)
}

func (a *app) nodesPage(w http.ResponseWriter, r *http.Request, s session) {
	a.render(w, http.StatusOK, "nodes", page{Title: "Nodes", User: s})
}

func (a *app) nodePage(w http.ResponseWriter, r *http.Request, s session) {
	a.render(w, http.StatusOK, "node", page{Title: r.PathValue("name"), User: s, Data: r.PathValue("name")})
}

type addData struct {
	NodesURL string
	Key      string
	Image    string
}

func (a *app) nodesURL(r *http.Request) string {
	base := a.cfg.publicURL
	if base == "" {
		scheme := "http"
		if r.TLS != nil || r.Header.Get("x-forwarded-proto") == "https" {
			scheme = "https"
		}
		base = scheme + "://" + r.Host
	}
	return "ws" + strings.TrimPrefix(base, "http") + "/nodes"
}

func (a *app) addPage(w http.ResponseWriter, r *http.Request, s session) {
	d := addData{NodesURL: a.nodesURL(r), Key: "<node key: ask an admin>", Image: env("SYNAPSE_HUB_IMAGE", "ghcr.io/synapse-control/hub:0.2")}
	if s.Role == roleAdmin {
		if k := a.hub.nodeKey(); k != "" {
			d.Key = k
		}
	}
	a.render(w, http.StatusOK, "add", page{Title: "Add a board", User: s, Data: d})
}

func (a *app) usersPage(w http.ResponseWriter, r *http.Request, s session) {
	a.render(w, http.StatusOK, "users", page{Title: "People", User: s, Data: a.users.list(), Error: r.URL.Query().Get("error")})
}

func (a *app) usersAdd(w http.ResponseWriter, r *http.Request, s session) {
	err := a.users.add(strings.TrimSpace(r.PostFormValue("name")), r.PostFormValue("password"), r.PostFormValue("role"), false)
	if err != nil {
		http.Redirect(w, r, "/users?error="+url.QueryEscape(err.Error()), http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/users", http.StatusSeeOther)
}

func (a *app) usersDelete(w http.ResponseWriter, r *http.Request, s session) {
	if err := a.users.remove(r.PathValue("name")); err != nil {
		http.Redirect(w, r, "/users?error="+url.QueryEscape(err.Error()), http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/users", http.StatusSeeOther)
}

func (a *app) events(w http.ResponseWriter, r *http.Request, s session) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("content-type", "text/event-stream")
	h.Set("cache-control", "no-store")
	h.Set("x-accel-buffering", "no")
	c, done := a.live.subscribe()
	defer done()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	fmt.Fprint(w, "retry: 2000\n\n")
	fl.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case data := <-c:
			fmt.Fprintf(w, "data: %s\n\n", data)
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

var toolRe = regexp.MustCompile(`^[a-z_]{1,64}$`)

func (a *app) apiCall(w http.ResponseWriter, r *http.Request, s session) {
	tool := r.PathValue("tool")
	w.Header().Set("content-type", "application/json")
	if !toolRe.MatchString(tool) {
		http.Error(w, `{"error":"no such tool"}`, http.StatusNotFound)
		return
	}
	args, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil || (len(args) > 0 && !json.Valid(args)) {
		http.Error(w, `{"error":"the body must be JSON"}`, http.StatusBadRequest)
		return
	}
	status, body, err := a.hub.call(r.Context(), tool, s.Role == roleAdmin, "user:"+s.Name, args)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": "hub unreachable: " + err.Error()})
		return
	}
	w.WriteHeader(status)
	w.Write(body)
}
