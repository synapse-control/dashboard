package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type hubClient struct {
	base     string
	tokenDir string
	http     *http.Client
}

func (h *hubClient) token(name string) (string, error) {
	b, err := os.ReadFile(filepath.Join(h.tokenDir, name))
	if err != nil {
		return "", fmt.Errorf("hub token %s: %w", name, err)
	}
	return strings.TrimSpace(string(b)), nil
}

func (h *hubClient) nodeKey() string {
	k, _ := h.token("node.key")
	return k
}

func (h *hubClient) call(ctx context.Context, tool string, write bool, by string, args json.RawMessage) (int, []byte, error) {
	name := "read.token"
	if write {
		name = "write.token"
	}
	tok, err := h.token(name)
	if err != nil {
		return 0, nil, err
	}
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.base+"/mcp/call/"+tool, bytes.NewReader(args))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("authorization", "Bearer "+tok)
	req.Header.Set("content-type", "application/json")
	if by != "" {
		req.Header.Set("x-synapse-by", by)
	}
	res, err := h.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	return res.StatusCode, body, err
}

func (h *hubClient) version(ctx context.Context) (string, error) {
	tok, err := h.token("read.token")
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.base+"/mcp/manifest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("authorization", "Bearer "+tok)
	res, err := h.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var v struct {
		Version string `json:"version"`
	}
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("manifest: HTTP %d", res.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&v); err != nil {
		return "", fmt.Errorf("manifest: %w", err)
	}
	return v.Version, nil
}

type node struct {
	Node      string   `json:"node"`
	ID        string   `json:"id"`
	Board     string   `json:"board"`
	Arch      string   `json:"arch"`
	Vio       float64  `json:"vio"`
	Transport string   `json:"transport"`
	Simulated bool     `json:"simulated"`
	Port      string   `json:"port,omitempty"`
	Spec      string   `json:"spec"`
	Beacon    *int     `json:"beacon,omitempty"`
	Wire      []string `json:"wire"`
}

type snapshot struct {
	HubOK      bool   `json:"hub_ok"`
	HubVersion string `json:"hub_version,omitempty"`
	HubError   string `json:"hub_error,omitempty"`
	Nodes      []node `json:"nodes"`
}

var beaconRe = regexp.MustCompile(`"beacon":(\d+)`)

func lastBeacon(lines []string) *int {
	for i := len(lines) - 1; i >= 0; i-- {
		if m := beaconRe.FindAllStringSubmatch(lines[i], -1); m != nil {
			var n int
			fmt.Sscanf(m[len(m)-1][1], "%d", &n)
			return &n
		}
	}
	return nil
}

func (h *hubClient) poll(ctx context.Context) snapshot {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	v, err := h.version(ctx)
	if err != nil {
		return snapshot{HubError: "hub unreachable: " + err.Error(), Nodes: []node{}}
	}
	status, body, err := h.call(ctx, "list_nodes", false, "", nil)
	if err == nil && status != http.StatusOK {
		err = fmt.Errorf("list_nodes: HTTP %d %s", status, bytes.TrimSpace(body))
	}
	if err != nil {
		return snapshot{HubVersion: v, HubError: err.Error(), Nodes: []node{}}
	}
	nodes := []node{}
	if err := json.Unmarshal(body, &nodes); err != nil {
		return snapshot{HubVersion: v, HubError: "list_nodes: " + err.Error(), Nodes: []node{}}
	}
	var wg sync.WaitGroup
	for i := range nodes {
		wg.Add(1)
		go func(n *node) {
			defer wg.Done()
			n.Wire = []string{}
			args, _ := json.Marshal(map[string]any{"node": n.Node, "n": 12})
			status, body, err := h.call(ctx, "wire_log", false, "", args)
			if err != nil || status != http.StatusOK {
				return
			}
			var w struct {
				Text string `json:"text"`
			}
			if json.Unmarshal(body, &w) != nil {
				return
			}
			for _, l := range strings.Split(w.Text, "\n") {
				if l != "" {
					n.Wire = append(n.Wire, l)
				}
			}
			n.Beacon = lastBeacon(n.Wire)
		}(&nodes[i])
	}
	wg.Wait()
	return snapshot{HubOK: true, HubVersion: v, Nodes: nodes}
}

type broadcaster struct {
	mu   sync.Mutex
	last []byte
	subs map[chan []byte]struct{}
}

func newBroadcaster() *broadcaster {
	return &broadcaster{subs: map[chan []byte]struct{}{}}
}

func (b *broadcaster) publish(s snapshot) {
	data, _ := json.Marshal(s)
	b.mu.Lock()
	defer b.mu.Unlock()
	if bytes.Equal(data, b.last) {
		return
	}
	b.last = data
	for c := range b.subs {
		select {
		case <-c:
		default:
		}
		c <- data
	}
}

func (b *broadcaster) subscribe() (chan []byte, func()) {
	c := make(chan []byte, 1)
	b.mu.Lock()
	b.subs[c] = struct{}{}
	if b.last != nil {
		c <- b.last
	}
	b.mu.Unlock()
	return c, func() {
		b.mu.Lock()
		delete(b.subs, c)
		b.mu.Unlock()
	}
}

func (b *broadcaster) current() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.last
}

func (a *app) pollLoop(ctx context.Context) {
	t := time.NewTicker(a.cfg.pollEvery)
	defer t.Stop()
	for {
		s := a.hub.poll(ctx)
		a.live.publish(s)
		a.observe(s)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
