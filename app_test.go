package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fakeHub(t *testing.T) (*httptest.Server, string) {
	dir := t.TempDir()
	for name, v := range map[string]string{"read.token": "R", "write.token": "W", "node.key": "K"} {
		os.WriteFile(filepath.Join(dir, name), []byte(v+"\n"), 0o600)
	}
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
		if r.URL.Path == "/nodes" {
			io.WriteString(w, "nodes door")
			return
		}
		if tok != "R" && tok != "W" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/mcp/manifest":
			io.WriteString(w, `{"version":"9.9.9"}`)
		case "/mcp/call/list_nodes":
			io.WriteString(w, `[{"node":"uno","board":"arduino-uno","transport":"ws"}]`)
		case "/mcp/call/wire_log":
			io.WriteString(w, `{"text":"< {\"data\":{\"beacon\":3}}\n< {\"data\":{\"beacon\":0}}\n"}`)
		case "/mcp/call/read":
			io.WriteString(w, `{"pin":"A0","v":3.1,"unit":"V","err":0.25}`)
		case "/mcp/call/write":
			if tok != "W" {
				w.WriteHeader(http.StatusForbidden)
				io.WriteString(w, `{"error":"read-only"}`)
				return
			}
			io.WriteString(w, `{"by":"`+r.Header.Get("x-synapse-by")+`"}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(hub.Close)
	return hub, dir
}

func testApp(t *testing.T) (*httptest.Server, *app) {
	hub, dir := fakeHub(t)
	cfg := loadConfig()
	cfg.hubURL, cfg.tokenDir, cfg.dataDir, cfg.pollEvery = hub.URL, dir, t.TempDir(), 20*time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a, err := newApp(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(a.routes())
	t.Cleanup(srv.Close)
	return srv, a
}

func client() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func post(t *testing.T, c *http.Client, u string, form url.Values) *http.Response {
	res, err := c.PostForm(u, form)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res
}

func callAPI(t *testing.T, c *http.Client, base, tool, body string, h map[string]string) (int, string) {
	req, _ := http.NewRequest(http.MethodPost, base+"/api/call/"+tool, strings.NewReader(body))
	req.Header.Set("content-type", "application/json")
	for k, v := range h {
		req.Header.Set(k, v)
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func send(t *testing.T, c *http.Client, method, u, body string) (int, string) {
	req, _ := http.NewRequest(method, u, strings.NewReader(body))
	req.Header.Set("content-type", "application/json")
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestFirstStartSetupThenRoles(t *testing.T) {
	srv, _ := testApp(t)
	anon := client()
	res, _ := anon.Get(srv.URL + "/")
	if loc := res.Header.Get("location"); loc != "/setup" {
		t.Fatalf("fresh install should send to /setup, got %q", loc)
	}
	adm := client()
	if r := post(t, adm, srv.URL+"/setup", url.Values{"name": {"andrew"}, "password": {"correcthorse1"}, "confirm": {"correcthorse1"}}); r.StatusCode != http.StatusFound {
		t.Fatalf("setup: %d", r.StatusCode)
	}
	if r := post(t, anon, srv.URL+"/setup", url.Values{"name": {"evil"}, "password": {"correcthorse1"}, "confirm": {"correcthorse1"}}); r.Header.Get("location") != "/login" {
		t.Fatal("a second setup must be refused")
	}
	if code, body := send(t, adm, "POST", srv.URL+"/api/users", `{"name":"vic","password":"viewerpass1","role":"viewer"}`); code != http.StatusCreated {
		t.Fatalf("add viewer: %d %s", code, body)
	}
	view := client()
	if r := post(t, view, srv.URL+"/login", url.Values{"name": {"vic"}, "password": {"viewerpass1"}}); r.StatusCode != http.StatusFound {
		t.Fatalf("viewer login: %d", r.StatusCode)
	}
	if code, body := callAPI(t, adm, srv.URL, "write", `{"pin":"D13","value":1}`, nil); code != 200 || !strings.Contains(body, "user:andrew") {
		t.Fatalf("admin write: %d %s", code, body)
	}
	if code, _ := callAPI(t, view, srv.URL, "write", `{"pin":"D13","value":1}`, nil); code != http.StatusForbidden {
		t.Fatalf("viewer write should be 403, got %d", code)
	}
	if code, _ := callAPI(t, anon, srv.URL, "list_nodes", `{}`, nil); code != http.StatusUnauthorized {
		t.Fatalf("anonymous call should be 401, got %d", code)
	}
	if code, _ := callAPI(t, adm, srv.URL, "write", `{}`, map[string]string{"origin": "https://evil.example", "sec-fetch-site": "cross-site"}); code != http.StatusForbidden {
		t.Fatalf("cross-site write should be 403, got %d", code)
	}
	if code, _ := callAPI(t, adm, srv.URL, "../x", `{}`, nil); code == 200 {
		t.Fatal("a bad tool name must not reach the hub")
	}
	if code, _ := send(t, view, "POST", srv.URL+"/api/users", `{"name":"eve","password":"viewerpass1","role":"admin"}`); code != http.StatusForbidden {
		t.Fatalf("viewer adding people: %d", code)
	}
	if code, _ := send(t, view, "POST", srv.URL+"/api/channels", `{"node":"uno","pin":"A0","as":"a","interval_ms":1000}`); code != http.StatusForbidden {
		t.Fatalf("viewer adding a channel: %d", code)
	}
	for _, c := range []struct {
		cl   *http.Client
		want bool
	}{{adm, true}, {view, false}} {
		_, body := send(t, c.cl, "GET", srv.URL+"/api/state", "")
		if got := strings.Contains(body, `"node_key":"K"`); got != c.want {
			t.Fatalf("node key shown=%v, want %v", got, c.want)
		}
	}
}

func TestRuleDrivesPinFromReading(t *testing.T) {
	srv, a := testApp(t)
	a.users.add("andrew", "correcthorse1", roleAdmin, true)
	c := client()
	post(t, c, srv.URL+"/login", url.Values{"name": {"andrew"}, "password": {"correcthorse1"}})
	code, body := send(t, c, "POST", srv.URL+"/api/channels", `{"node":"uno","pin":"A0","as":"a","scale":1,"interval_ms":250}`)
	if code != http.StatusCreated {
		t.Fatalf("channel: %d %s", code, body)
	}
	var ch channel
	json.Unmarshal([]byte(body), &ch)
	lamp := `{"name":"lamp","channel":"` + ch.ID + `","op":">","threshold":2.5,"then":{"node":"uno","pin":"D13","mode":"high"},"else":{"node":"uno","pin":"D13","mode":"low"}}`
	if code, body := send(t, c, "POST", srv.URL+"/api/rules", lamp); code != http.StatusCreated {
		t.Fatalf("rule: %d %s", code, body)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var r rule
		a.store.read(func(st *state) { r = st.Rules[0] })
		if r.Executions == 1 && r.LastResult == "set uno D13 high" && len(a.store.recent(ch.ID)) > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the rule did not drive D13 high from a 3.1 V reading")
}

func TestLoginLimit(t *testing.T) {
	srv, a := testApp(t)
	a.users.add("andrew", "correcthorse1", roleAdmin, true)
	c := client()
	for range loginTries {
		if r := post(t, c, srv.URL+"/login", url.Values{"name": {"andrew"}, "password": {"wrongwrong1"}}); r.StatusCode != http.StatusUnauthorized {
			t.Fatalf("wrong password: %d", r.StatusCode)
		}
	}
	if r := post(t, c, srv.URL+"/login", url.Values{"name": {"andrew"}, "password": {"correcthorse1"}}); r.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("after %d failures: %d", loginTries, r.StatusCode)
	}
}

func TestSessionTamperAndRemovedUser(t *testing.T) {
	srv, a := testApp(t)
	a.users.add("andrew", "correcthorse1", roleAdmin, true)
	a.users.add("vic", "viewerpass1", roleViewer, false)
	c := client()
	post(t, c, srv.URL+"/login", url.Values{"name": {"vic"}, "password": {"viewerpass1"}})
	u, _ := url.Parse(srv.URL)
	raw := c.Jar.Cookies(u)[0].Value
	p, sig, _ := strings.Cut(raw, ".")
	forged := a.sess.sign(session{Name: "vic", Role: roleAdmin, Source: "oidc", Exp: time.Now().Add(time.Hour).Unix()})
	fp, _, _ := strings.Cut(forged, ".")
	for _, v := range []string{fp + "." + sig, p + "x." + sig} {
		var s session
		if a.sess.verify(v, &s) {
			t.Fatalf("tampered cookie verified: %q", v)
		}
	}
	a.users.remove("vic")
	res, _ := c.Get(srv.URL + "/")
	if res.Header.Get("location") != "/login" {
		t.Fatal("a removed user's session must end")
	}
	if a.users.remove("andrew") == nil {
		t.Fatal("the last admin must not be removable")
	}
}

func TestLiveSnapshotAndProxy(t *testing.T) {
	srv, a := testApp(t)
	deadline := time.Now().Add(2 * time.Second)
	var s snapshot
	for time.Now().Before(deadline) {
		if cur := a.live.current(); cur != nil {
			json.Unmarshal(cur, &s)
			if s.HubOK {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !s.HubOK || s.HubVersion != "9.9.9" || len(s.Nodes) != 1 || s.Nodes[0].Beacon == nil || *s.Nodes[0].Beacon != 0 {
		t.Fatalf("snapshot: %+v", s)
	}
	res, _ := http.Get(srv.URL + "/nodes")
	b, _ := io.ReadAll(res.Body)
	if string(b) != "nodes door" {
		t.Fatalf("/nodes must reach the hub: %q", b)
	}
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/mcp/manifest", nil)
	req.Header.Set("authorization", "Bearer R")
	res, _ = http.DefaultClient.Do(req)
	if res.StatusCode != 200 {
		t.Fatalf("/mcp/ must pass the bearer to the hub: %d", res.StatusCode)
	}
	res, _ = http.Get(srv.URL + "/health")
	if res.StatusCode != 200 {
		t.Fatalf("health: %d", res.StatusCode)
	}
}
