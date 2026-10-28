package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

type config struct {
	addr         string
	hubURL       string
	tokenDir     string
	dataDir      string
	publicURL    string
	nodesURL     string
	localLogin   bool
	oidcIssuer   string
	oidcID       string
	oidcSecret   string
	oidcAdmin    string
	oidcClaim    string
	oidcRedirect string
	pollEvery    time.Duration
}

func env(name, def string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return def
}

func loadConfig() config {
	return config{
		addr:         env("DASHBOARD_ADDR", ":8080"),
		hubURL:       strings.TrimRight(env("SYNAPSE_HUB_URL", "http://hub:4010"), "/"),
		tokenDir:     env("SYNAPSE_TOKEN_DIR", "/data/tokens"),
		dataDir:      env("DASHBOARD_DATA", "/data/dashboard"),
		publicURL:    strings.TrimRight(env("SYNAPSE_PUBLIC_URL", ""), "/"),
		nodesURL:     env("SYNAPSE_NODES_URL", ""),
		localLogin:   env("DASHBOARD_LOCAL_LOGIN", "true") != "false",
		oidcIssuer:   env("OIDC_ISSUER", ""),
		oidcID:       env("OIDC_CLIENT_ID", ""),
		oidcSecret:   env("OIDC_CLIENT_SECRET", ""),
		oidcAdmin:    env("OIDC_ADMIN_GROUP", ""),
		oidcClaim:    env("OIDC_GROUPS_CLAIM", "groups"),
		oidcRedirect: env("OIDC_REDIRECT_URL", ""),
		pollEvery:    time.Second,
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "health" {
		addr := env("DASHBOARD_ADDR", ":8080")
		if strings.HasPrefix(addr, ":") {
			addr = "127.0.0.1" + addr
		}
		res, err := http.Get("http://" + addr + "/health")
		if err != nil || res.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	cfg := loadConfig()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	app, err := newApp(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Addr: cfg.addr, Handler: app.routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shut)
	}()
	log.Printf("synapse dashboard %s on %s, hub %s", version, cfg.addr, cfg.hubURL)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
