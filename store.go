package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type device struct {
	Node        string    `json:"node"`
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Board       string    `json:"board"`
	Arch        string    `json:"arch"`
	Transport   string    `json:"transport"`
	Where       string    `json:"where"`
	Simulated   bool      `json:"simulated"`
	FirstSeen   time.Time `json:"first_seen"`
	LastSeen    time.Time `json:"last_seen"`
	Online      bool      `json:"online"`
}

type channel struct {
	ID         string    `json:"id"`
	Node       string    `json:"node"`
	Pin        string    `json:"pin"`
	As         string    `json:"as"`
	Label      string    `json:"label"`
	Unit       string    `json:"unit"`
	Scale      float64   `json:"scale"`
	Offset     float64   `json:"offset"`
	IntervalMs int       `json:"interval_ms"`
	Created    time.Time `json:"created"`
}

type output struct {
	Node string  `json:"node"`
	Pin  string  `json:"pin"`
	Mode string  `json:"mode"`
	Duty float64 `json:"duty,omitempty"`
	Hz   float64 `json:"hz,omitempty"`
}

type rule struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Template   string    `json:"template,omitempty"`
	Channel    string    `json:"channel"`
	Op         string    `json:"op"`
	Threshold  float64   `json:"threshold"`
	Then       output    `json:"then"`
	Else       *output   `json:"else,omitempty"`
	Enabled    bool      `json:"enabled"`
	Version    int       `json:"version"`
	Executions int       `json:"executions"`
	LastAt     time.Time `json:"last_at,omitzero"`
	LastResult string    `json:"last_result,omitempty"`
	State      *bool     `json:"state,omitempty"`
	Created    time.Time `json:"created"`
	By         string    `json:"by"`
}

type webhook struct {
	ID       string    `json:"id"`
	URL      string    `json:"url"`
	Event    string    `json:"event"`
	Enabled  bool      `json:"enabled"`
	Secret   string    `json:"secret"`
	LastAt   time.Time `json:"last_at,omitzero"`
	LastCode int       `json:"last_code,omitempty"`
	LastErr  string    `json:"last_error,omitempty"`
}

type entry struct {
	ID      string         `json:"id"`
	Time    time.Time      `json:"time"`
	Kind    string         `json:"kind"`
	Alert   bool           `json:"alert"`
	Message string         `json:"message"`
	Node    string         `json:"node,omitempty"`
	Meta    map[string]any `json:"meta,omitempty"`
}

type settings struct {
	RetentionDays int `json:"retention_days"`
}

type state struct {
	Devices  []device             `json:"devices"`
	Channels []channel            `json:"channels"`
	Rules    []rule               `json:"rules"`
	Webhooks []webhook            `json:"webhooks"`
	Settings settings             `json:"settings"`
	Audit    []entry              `json:"audit"`
	Seen     map[string]time.Time `json:"alerts_seen"`
}

type reading struct {
	C string  `json:"c"`
	T int64   `json:"t"`
	V float64 `json:"v"`
	E float64 `json:"e"`
}

const (
	auditMax = 1000
	ringMax  = 600
)

type store struct {
	mu    sync.Mutex
	dir   string
	st    state
	rings map[string][]reading
	day   string
	file  *os.File
}

func newID(prefix string) string {
	b := make([]byte, 5)
	rand.Read(b)
	return prefix + "-" + hex.EncodeToString(b)
}

func openStore(dir string) (*store, error) {
	s := &store{dir: dir, rings: map[string][]reading{}}
	s.st.Settings.RetentionDays = 30
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		if err := json.Unmarshal(b, &s.st); err != nil {
			return nil, err
		}
	}
	if s.st.Seen == nil {
		s.st.Seen = map[string]time.Time{}
	}
	for i := range s.st.Devices {
		s.st.Devices[i].Online = false
	}
	if err := os.MkdirAll(filepath.Join(dir, "readings"), 0o700); err != nil {
		return nil, err
	}
	s.loadRecent()
	return s, nil
}

func (s *store) saveLocked() error {
	b, err := json.MarshalIndent(s.st, "", " ")
	if err != nil {
		return err
	}
	p := filepath.Join(s.dir, "state.json")
	if err := os.WriteFile(p+".tmp", b, 0o600); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}

func (s *store) update(fn func(st *state) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := fn(&s.st); err != nil {
		return err
	}
	return s.saveLocked()
}

func (s *store) read(fn func(st *state)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.st)
}

func (s *store) snapshot() state {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.st
	c.Devices = slices.Clone(s.st.Devices)
	c.Channels = slices.Clone(s.st.Channels)
	c.Rules = slices.Clone(s.st.Rules)
	c.Webhooks = slices.Clone(s.st.Webhooks)
	c.Audit = slices.Clone(s.st.Audit)
	return c
}

func (s *store) audit(e entry) entry {
	e.ID = newID("log")
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.st.Audit = append(s.st.Audit, e)
	if len(s.st.Audit) > auditMax {
		s.st.Audit = slices.Clone(s.st.Audit[len(s.st.Audit)-auditMax:])
	}
	s.saveLocked()
	return e
}

func (s *store) unseen(user string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	since := s.st.Seen[user]
	n := 0
	for _, e := range s.st.Audit {
		if e.Alert && e.Time.After(since) {
			n++
		}
	}
	return n
}

func dayOf(t time.Time) string { return t.UTC().Format("2006-01-02") }

func (s *store) record(r reading) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ring := append(s.rings[r.C], r)
	if len(ring) > ringMax {
		ring = slices.Clone(ring[len(ring)-ringMax:])
	}
	s.rings[r.C] = ring
	d := dayOf(time.UnixMilli(r.T))
	if d != s.day || s.file == nil {
		if s.file != nil {
			s.file.Close()
		}
		f, err := os.OpenFile(filepath.Join(s.dir, "readings", d+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			s.file = nil
			return
		}
		s.file, s.day = f, d
	}
	b, _ := json.Marshal(r)
	s.file.Write(append(b, '\n'))
}

func (s *store) recent(id string) []reading {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.rings[id])
}

func (s *store) forgetChannel(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rings, id)
}

func (s *store) loadRecent() {
	now := time.Now()
	for _, d := range []string{dayOf(now.Add(-24 * time.Hour)), dayOf(now)} {
		s.scan(d, func(r reading) {
			ring := append(s.rings[r.C], r)
			if len(ring) > ringMax {
				ring = ring[1:]
			}
			s.rings[r.C] = ring
		})
	}
}

func (s *store) scan(day string, fn func(reading)) {
	f, err := os.Open(filepath.Join(s.dir, "readings", day+".jsonl"))
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var r reading
		if json.Unmarshal(sc.Bytes(), &r) == nil {
			fn(r)
		}
	}
}

func (s *store) history(id string, from, to time.Time) []reading {
	out := []reading{}
	for d := from.UTC().Truncate(24 * time.Hour); !d.After(to); d = d.Add(24 * time.Hour) {
		s.scan(dayOf(d), func(r reading) {
			if r.C == id && r.T >= from.UnixMilli() && r.T <= to.UnixMilli() {
				out = append(out, r)
			}
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].T < out[j].T })
	return out
}

func (s *store) prune() {
	s.mu.Lock()
	days := s.st.Settings.RetentionDays
	s.mu.Unlock()
	if days < 1 {
		return
	}
	cut := dayOf(time.Now().AddDate(0, 0, -days))
	files, _ := os.ReadDir(filepath.Join(s.dir, "readings"))
	for _, f := range files {
		name := strings.TrimSuffix(f.Name(), ".jsonl")
		if name < cut {
			os.Remove(filepath.Join(s.dir, "readings", f.Name()))
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	limit := time.Now().AddDate(0, 0, -days)
	s.st.Audit = slices.DeleteFunc(s.st.Audit, func(e entry) bool { return e.Time.Before(limit) })
	s.saveLocked()
}
