package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"slices"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

type oidcLogin struct {
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
	conf     oauth2.Config
	admin    string
	claim    string
}

func newOIDC(ctx context.Context, cfg config) (*oidcLogin, error) {
	p, err := oidc.NewProvider(ctx, cfg.oidcIssuer)
	if err != nil {
		return nil, err
	}
	scopes := []string{oidc.ScopeOpenID, "profile", "email"}
	if cfg.oidcAdmin != "" {
		scopes = append(scopes, cfg.oidcClaim)
	}
	return &oidcLogin{
		provider: p,
		verifier: p.Verifier(&oidc.Config{ClientID: cfg.oidcID}),
		conf: oauth2.Config{
			ClientID: cfg.oidcID, ClientSecret: cfg.oidcSecret, Endpoint: p.Endpoint(),
			RedirectURL: cfg.oidcRedirect,
			Scopes:      scopes,
		},
		admin: cfg.oidcAdmin,
		claim: cfg.oidcClaim,
	}, nil
}

type oidcState struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	Exp      int64  `json:"e"`
}

const stateCookie = "synapse_oidc"

func randomString() string {
	b := make([]byte, 24)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (a *app) oidcStart(w http.ResponseWriter, r *http.Request) {
	st := oidcState{State: randomString(), Nonce: randomString(), Verifier: oauth2.GenerateVerifier(), Exp: time.Now().Add(10 * time.Minute).Unix()}
	a.sess.set(w, stateCookie, a.sess.sign(st), 10*time.Minute)
	http.Redirect(w, r, a.oidc.conf.AuthCodeURL(st.State, oidc.Nonce(st.Nonce), oauth2.S256ChallengeOption(st.Verifier)), http.StatusFound)
}

func (a *app) oidcCallback(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(stateCookie)
	var st oidcState
	if err != nil || !a.sess.verify(c.Value, &st) || time.Now().Unix() > st.Exp || r.URL.Query().Get("state") != st.State {
		a.fail(w, r, http.StatusBadRequest, "The sign-in expired or did not start here. Try again.")
		return
	}
	a.sess.clear(w, stateCookie)
	tok, err := a.oidc.conf.Exchange(r.Context(), r.URL.Query().Get("code"), oauth2.VerifierOption(st.Verifier))
	if err != nil {
		a.fail(w, r, http.StatusBadGateway, "The identity provider refused the sign-in.")
		return
	}
	raw, _ := tok.Extra("id_token").(string)
	idt, err := a.oidc.verifier.Verify(r.Context(), raw)
	if err != nil || idt.Nonce != st.Nonce {
		a.fail(w, r, http.StatusBadGateway, "The identity provider's answer did not verify.")
		return
	}
	var claims map[string]any
	idt.Claims(&claims)
	name := idt.Subject
	for _, k := range []string{"preferred_username", "email", "name"} {
		if v, ok := claims[k].(string); ok && v != "" {
			name = v
			break
		}
	}
	role := roleAdmin
	if a.oidc.admin != "" {
		role = roleViewer
		if groups, ok := claims[a.oidc.claim].([]any); ok && slices.Contains(groups, any(a.oidc.admin)) {
			role = roleAdmin
		}
	}
	a.sess.start(w, name, role, "oidc", 12*time.Hour)
	http.Redirect(w, r, "/", http.StatusFound)
}
