package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func fakeIssuer(t *testing.T, groups []string) *httptest.Server {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	b64 := base64.RawURLEncoding.EncodeToString
	codes := map[string]url.Values{}
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"issuer": srv.URL, "authorization_endpoint": srv.URL + "/auth", "token_endpoint": srv.URL + "/token",
			"jwks_uri": srv.URL + "/jwks", "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": "k", "alg": "RS256", "use": "sig",
			"n": b64(key.N.Bytes()), "e": b64(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/auth", func(w http.ResponseWriter, r *http.Request) {
		code := randomString()
		codes[code] = r.URL.Query()
		http.Redirect(w, r, r.URL.Query().Get("redirect_uri")+"?code="+code+"&state="+r.URL.Query().Get("state"), http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		q, ok := codes[r.PostForm.Get("code")]
		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		if !ok || q.Get("code_challenge") != b64(sum[:]) {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		head := b64([]byte(`{"alg":"RS256","kid":"k","typ":"JWT"}`))
		body, _ := json.Marshal(map[string]any{
			"iss": srv.URL, "aud": "dash", "sub": "u1", "preferred_username": "ada", "groups": groups,
			"nonce": q.Get("nonce"), "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(),
		})
		signing := head + "." + b64(body)
		h := sha256.Sum256([]byte(signing))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, h[:])
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"access_token": "a", "token_type": "Bearer", "id_token": signing + "." + b64(sig)})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestOIDCSignIn(t *testing.T) {
	for _, c := range []struct {
		groups []string
		admin  string
		want   string
	}{{nil, "", roleAdmin}, {[]string{"people"}, "synapse-admins", roleViewer}, {[]string{"synapse-admins"}, "synapse-admins", roleAdmin}} {
		idp := fakeIssuer(t, c.groups)
		hub, dir := fakeHub(t)
		cfg := loadConfig()
		cfg.hubURL, cfg.tokenDir, cfg.dataDir = hub.URL, dir, t.TempDir()
		cfg.oidcIssuer, cfg.oidcID, cfg.oidcSecret, cfg.oidcAdmin, cfg.localLogin = idp.URL, "dash", "s", c.admin, false
		srv := httptest.NewUnstartedServer(nil)
		cfg.publicURL = "http://" + srv.Listener.Addr().String()
		cfg.oidcRedirect = cfg.publicURL + "/auth/v1/callback"
		ctx, cancel := context.WithCancel(context.Background())
		a, err := newApp(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		srv.Config.Handler = a.routes()
		srv.Start()
		cl := client()
		cl.CheckRedirect = nil
		res, err := cl.Get(srv.URL + "/auth/oidc")
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if !strings.HasSuffix(res.Request.URL.Path, "/") || res.Request.URL.Host != srv.Listener.Addr().String() {
			t.Fatalf("sign-in should land on the dashboard, landed on %s", res.Request.URL)
		}
		code, _ := callAPI(t, cl, srv.URL, "write", `{"pin":"D13","value":1}`, nil)
		if want := map[string]int{roleAdmin: 200, roleViewer: 403}[c.want]; code != want {
			t.Fatalf("groups %v, admin group %q: write gave %d, want %d", c.groups, c.admin, code, want)
		}
		if r, _ := http.PostForm(srv.URL+"/login", url.Values{"name": {"x"}, "password": {"y"}}); r.StatusCode != http.StatusNotFound {
			t.Fatalf("local sign-in should be off: %d", r.StatusCode)
		}
		srv.Close()
		cancel()
	}
}
