package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	roleAdmin  = "admin"
	roleViewer = "viewer"
)

type user struct {
	Name string `json:"name"`
	Hash string `json:"hash"`
	Role string `json:"role"`
}

type userStore struct {
	mu    sync.Mutex
	path  string
	users []user
}

var nameRe = regexp.MustCompile(`^[a-zA-Z0-9._@-]{1,64}$`)

func openUsers(dir string) (*userStore, error) {
	s := &userStore{path: filepath.Join(dir, "users.json")}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	return s, json.Unmarshal(b, &s.users)
}

func (s *userStore) saveLocked() error {
	b, err := json.MarshalIndent(s.users, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *userStore) empty() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.users) == 0
}

func (s *userStore) list() []user {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.users)
}

func (s *userStore) get(name string) (user, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, u := range s.users {
		if u.Name == name {
			return u, true
		}
	}
	return user{}, false
}

func (s *userStore) add(name, password, role string, onlyIfEmpty bool) error {
	if !nameRe.MatchString(name) {
		return errors.New("a name is 1 to 64 letters, digits or . _ @ -")
	}
	if len(password) < 10 || len(password) > 72 {
		return errors.New("a password is 10 to 72 characters")
	}
	if role != roleAdmin && role != roleViewer {
		return errors.New("role is admin or viewer")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if onlyIfEmpty && len(s.users) > 0 {
		return errors.New("setup is already done")
	}
	for _, u := range s.users {
		if u.Name == name {
			return errors.New("that name is taken")
		}
	}
	s.users = append(s.users, user{Name: name, Hash: string(hash), Role: role})
	return s.saveLocked()
}

func (s *userStore) remove(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	admins := 0
	for _, u := range s.users {
		if u.Role == roleAdmin {
			admins++
		}
	}
	for i, u := range s.users {
		if u.Name == name {
			if u.Role == roleAdmin && admins == 1 {
				return errors.New("the last admin cannot be removed")
			}
			s.users = slices.Delete(s.users, i, i+1)
			return s.saveLocked()
		}
	}
	return errors.New("no such user")
}

var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("synapse-dummy-password"), 12)

func (s *userStore) check(name, password string) (user, bool) {
	u, ok := s.get(name)
	hash := dummyHash
	if ok {
		hash = []byte(u.Hash)
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(password)) != nil || !ok {
		return user{}, false
	}
	return u, true
}

type session struct {
	Name   string `json:"n"`
	Role   string `json:"r"`
	Source string `json:"s"`
	Exp    int64  `json:"e"`
}

type sessions struct {
	key    []byte
	secure bool
}

const sessionCookie = "synapse_session"

func loadKey(dir, name string) ([]byte, error) {
	p := filepath.Join(dir, name)
	b, err := os.ReadFile(p)
	if err == nil {
		return hex.DecodeString(strings.TrimSpace(string(b)))
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	k := make([]byte, 32)
	rand.Read(k)
	return k, os.WriteFile(p, []byte(hex.EncodeToString(k)), 0o600)
}

func (s *sessions) sign(v any) string {
	b, _ := json.Marshal(v)
	p := base64.RawURLEncoding.EncodeToString(b)
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(p))
	return p + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *sessions) verify(raw string, v any) bool {
	p, sig, ok := strings.Cut(raw, ".")
	if !ok {
		return false
	}
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(p))
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(got, m.Sum(nil)) {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(p)
	return err == nil && json.Unmarshal(b, v) == nil
}

func (s *sessions) set(w http.ResponseWriter, name, value string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: "/", HttpOnly: true, Secure: s.secure,
		SameSite: http.SameSiteLaxMode, MaxAge: int(ttl.Seconds()),
	})
}

func (s *sessions) clear(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", HttpOnly: true, Secure: s.secure, MaxAge: -1})
}

func (s *sessions) start(w http.ResponseWriter, name, role, source string, ttl time.Duration) {
	s.set(w, sessionCookie, s.sign(session{Name: name, Role: role, Source: source, Exp: time.Now().Add(ttl).Unix()}), ttl)
}

func (a *app) current(r *http.Request) (session, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return session{}, false
	}
	var s session
	if !a.sess.verify(c.Value, &s) || time.Now().Unix() > s.Exp {
		return session{}, false
	}
	if s.Source == "local" {
		u, ok := a.users.get(s.Name)
		if !ok || !a.cfg.localLogin {
			return session{}, false
		}
		s.Role = u.Role
	}
	return s, true
}

type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

const (
	loginTries  = 5
	loginWindow = 15 * time.Minute
)

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (l *limiter) blocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := time.Now().Add(-loginWindow)
	l.hits[ip] = slices.DeleteFunc(l.hits[ip], func(t time.Time) bool { return t.Before(cut) })
	if len(l.hits[ip]) == 0 {
		delete(l.hits, ip)
	}
	return len(l.hits[ip]) >= loginTries
}

func (l *limiter) fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.hits[ip] = append(l.hits[ip], time.Now())
}
