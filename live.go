package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

type feed struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

func newFeed() *feed { return &feed{subs: map[chan []byte]struct{}{}} }

func (f *feed) send(kind string, v any) {
	data, _ := json.Marshal(map[string]any{"kind": kind, "data": v})
	f.mu.Lock()
	defer f.mu.Unlock()
	for c := range f.subs {
		select {
		case c <- data:
		default:
		}
	}
}

func (f *feed) subscribe() (chan []byte, func()) {
	c := make(chan []byte, 256)
	f.mu.Lock()
	f.subs[c] = struct{}{}
	f.mu.Unlock()
	return c, func() {
		f.mu.Lock()
		delete(f.subs, c)
		f.mu.Unlock()
	}
}

type engine struct {
	mu       sync.Mutex
	polled   bool
	hubUp    bool
	beacons  map[string]int
	chanErr  map[string]string
	asserted map[string]time.Time
	saved    time.Time
	hooks    chan hookJob
}

type hookJob struct {
	id   string
	url  string
	key  string
	kind string
	body []byte
}

func newEngine() *engine {
	return &engine{beacons: map[string]int{}, chanErr: map[string]string{}, asserted: map[string]time.Time{}, hooks: make(chan hookJob, 64)}
}

func (a *app) log(kind string, alert bool, node, msg string, meta map[string]any) {
	e := a.store.audit(entry{Kind: kind, Alert: alert, Node: node, Message: msg, Meta: meta})
	a.feed.send("audit", e)
	body, _ := json.Marshal(map[string]any{"event": e.Kind, "alert": e.Alert, "time": e.Time, "node": e.Node, "message": e.Message, "meta": e.Meta})
	a.store.read(func(st *state) {
		for _, w := range st.Webhooks {
			if w.Enabled && (w.Event == "all" || w.Event == e.Kind || (w.Event == "alert" && e.Alert)) {
				select {
				case a.eng.hooks <- hookJob{id: w.ID, url: w.URL, key: w.Secret, kind: e.Kind, body: body}:
				default:
				}
			}
		}
	})
}

func (a *app) changed() { a.feed.send("config", nil) }

func (a *app) observe(s snapshot) {
	a.eng.mu.Lock()
	first, wasUp := !a.eng.polled, a.eng.hubUp
	a.eng.polled, a.eng.hubUp = true, s.HubOK
	a.eng.mu.Unlock()
	if !s.HubOK {
		if wasUp {
			a.log("hub.down", true, "", "The hub stopped answering: "+s.HubError, nil)
		}
		return
	}
	if !wasUp && !first {
		a.log("hub.up", false, "", "The hub answers again", nil)
	}
	now := time.Now()
	var fresh, joined, dropped []device
	a.store.mu.Lock()
	st := &a.store.st
	seen := map[string]bool{}
	dirty := false
	for _, n := range s.Nodes {
		seen[n.Node] = true
		i := slices.IndexFunc(st.Devices, func(d device) bool { return d.Node == n.Node })
		isNew := i < 0
		if isNew {
			st.Devices = append(st.Devices, device{Node: n.Node, Name: n.Node, FirstSeen: now, Board: n.Board})
			i = len(st.Devices) - 1
			fresh = append(fresh, st.Devices[i])
		}
		d := &st.Devices[i]
		if !d.Online {
			dirty = true
			if !first && !isNew {
				joined = append(joined, *d)
			}
		}
		d.ID, d.Board, d.Arch, d.Transport, d.Where, d.Simulated = n.ID, n.Board, n.Arch, n.Transport, n.Port, n.Simulated
		if d.Where == "" {
			d.Where = n.Spec
		}
		d.Online, d.LastSeen = true, now
	}
	for i := range st.Devices {
		if st.Devices[i].Online && !seen[st.Devices[i].Node] {
			st.Devices[i].Online = false
			dropped = append(dropped, st.Devices[i])
			dirty = true
		}
	}
	if dirty || now.Sub(a.eng.saved) > time.Minute {
		a.store.saveLocked()
		a.eng.saved = now
	}
	a.store.mu.Unlock()
	for _, d := range fresh {
		a.log("device.new", false, d.Node, fmt.Sprintf("New device %s (%s) reached the hub", d.Node, d.Board), nil)
	}
	for _, d := range joined {
		a.log("node.joined", false, d.Node, fmt.Sprintf("%s is back on the hub", d.Name), nil)
	}
	for _, d := range dropped {
		a.log("node.dropped", true, d.Node, fmt.Sprintf("%s dropped off the hub", d.Name), nil)
	}
	if len(fresh)+len(joined)+len(dropped) > 0 {
		a.changed()
	}
	for _, n := range s.Nodes {
		if n.Beacon == nil {
			continue
		}
		a.eng.mu.Lock()
		prev, had := a.eng.beacons[n.Node]
		a.eng.beacons[n.Node] = *n.Beacon
		a.eng.mu.Unlock()
		if had && prev == *n.Beacon {
			continue
		}
		switch *n.Beacon {
		case 5:
			a.log("node.failsafe", true, n.Node, n.Node+" fired its failsafe: outputs went hi-Z", nil)
		case 4:
			a.log("node.brownout", true, n.Node, n.Node+" browned out and holds its radio off", nil)
		}
	}
}

func (a *app) sampleLoop(ctx context.Context) {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	next := map[string]time.Time{}
	var mu sync.Mutex
	busy := map[string]bool{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		now := time.Now()
		var due []channel
		a.store.read(func(st *state) {
			online := map[string]bool{}
			for _, d := range st.Devices {
				online[d.Node] = d.Online
			}
			for _, c := range st.Channels {
				if online[c.Node] && !now.Before(next[c.ID]) {
					due = append(due, c)
				}
			}
		})
		for _, c := range due {
			mu.Lock()
			if busy[c.ID] {
				mu.Unlock()
				continue
			}
			busy[c.ID] = true
			mu.Unlock()
			next[c.ID] = now.Add(time.Duration(c.IntervalMs) * time.Millisecond)
			go func(c channel) {
				a.sample(ctx, c)
				mu.Lock()
				delete(busy, c.ID)
				mu.Unlock()
			}(c)
		}
	}
}

type measurement struct {
	V     float64  `json:"v"`
	Err   float64  `json:"err"`
	Unit  string   `json:"unit"`
	Flags []string `json:"flags"`
}

func hubError(status int, body []byte, err error) string {
	if err != nil {
		return "hub unreachable: " + err.Error()
	}
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil && e.Error != "" {
		var inner struct {
			Error struct {
				Code string `json:"code"`
				Msg  string `json:"msg"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(e.Error), &inner) == nil && inner.Error.Msg != "" {
			return inner.Error.Code + ": " + inner.Error.Msg
		}
		return e.Error
	}
	return fmt.Sprintf("HTTP %d", status)
}

func (a *app) measure(ctx context.Context, c channel) (float64, float64, error) {
	n := 1
	if c.As == "a" {
		n = 16
	}
	args, _ := json.Marshal(map[string]any{"node": c.Node, "pin": c.Pin, "as": c.As, "n": n})
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	status, body, err := a.hub.call(ctx, "read", false, "", args)
	if err != nil || status != http.StatusOK {
		return 0, 0, fmt.Errorf("%s", hubError(status, body, err))
	}
	var m measurement
	if err := json.Unmarshal(body, &m); err != nil {
		return 0, 0, err
	}
	scale := c.Scale
	if scale == 0 {
		scale = 1
	}
	return round4(m.V*scale + c.Offset), round4(m.Err * math.Abs(scale)), nil
}

func round4(v float64) float64 { return math.Round(v*1e4) / 1e4 }

func (a *app) sample(ctx context.Context, c channel) {
	v, e, err := a.measure(ctx, c)
	a.eng.mu.Lock()
	prev := a.eng.chanErr[c.ID]
	if err != nil {
		a.eng.chanErr[c.ID] = err.Error()
	} else {
		delete(a.eng.chanErr, c.ID)
	}
	a.eng.mu.Unlock()
	if err != nil {
		if prev != err.Error() {
			a.feed.send("channel", map[string]string{"id": c.ID, "error": err.Error()})
		}
		return
	}
	if prev != "" {
		a.feed.send("channel", map[string]string{"id": c.ID, "error": ""})
	}
	r := reading{C: c.ID, T: time.Now().UnixMilli(), V: v, E: e}
	a.store.record(r)
	a.feed.send("reading", r)
	a.evaluate(ctx, c, v)
}

func compare(v float64, op string, th float64) bool {
	switch op {
	case ">":
		return v > th
	case ">=":
		return v >= th
	case "<":
		return v < th
	case "<=":
		return v <= th
	case "==":
		return v == th
	case "!=":
		return v != th
	}
	return false
}

func (o output) describe() string {
	switch o.Mode {
	case "high":
		return fmt.Sprintf("%s %s high", o.Node, o.Pin)
	case "low":
		return fmt.Sprintf("%s %s low", o.Node, o.Pin)
	}
	return fmt.Sprintf("%s %s PWM %.0f%%", o.Node, o.Pin, o.Duty*100)
}

func (a *app) drive(ctx context.Context, o output) error {
	args := map[string]any{"node": o.Node, "pin": o.Pin}
	switch o.Mode {
	case "high":
		args["value"] = 1
	case "low":
		args["value"] = 0
	default:
		hz := o.Hz
		if hz <= 0 {
			hz = 490
		}
		args["pwm"] = map[string]float64{"hz": hz, "duty": o.Duty}
	}
	b, _ := json.Marshal(args)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	status, body, err := a.hub.call(ctx, "write", true, "user:rules", b)
	if err != nil || status != http.StatusOK {
		return fmt.Errorf("%s", hubError(status, body, err))
	}
	return nil
}

const reassert = 30 * time.Second

func (a *app) evaluate(ctx context.Context, c channel, v float64) {
	var rules []rule
	a.store.read(func(st *state) {
		for _, r := range st.Rules {
			if r.Enabled && r.Channel == c.ID {
				rules = append(rules, r)
			}
		}
	})
	for _, r := range rules {
		cond := compare(v, r.Op, r.Threshold)
		flipped := r.State == nil || *r.State != cond
		target := &r.Then
		if !cond {
			target = r.Else
		}
		a.eng.mu.Lock()
		stale := time.Since(a.eng.asserted[r.ID]) > reassert
		a.eng.mu.Unlock()
		if target == nil && !flipped {
			continue
		}
		if target != nil && !flipped && !stale {
			continue
		}
		result := "condition " + map[bool]string{true: "met", false: "cleared"}[cond]
		var err error
		if target != nil {
			err = a.drive(ctx, *target)
			if err == nil {
				result = "set " + target.describe()
				a.eng.mu.Lock()
				a.eng.asserted[r.ID] = time.Now()
				a.eng.mu.Unlock()
			} else {
				result = "failed: " + err.Error()
			}
		}
		var prevResult string
		a.store.update(func(st *state) error {
			i := slices.IndexFunc(st.Rules, func(x rule) bool { return x.ID == r.ID })
			if i < 0 {
				return nil
			}
			x := &st.Rules[i]
			prevResult = x.LastResult
			if flipped {
				x.State = &cond
				if target != nil {
					x.Executions++
				}
				x.LastAt = time.Now()
			}
			x.LastResult = result
			return nil
		})
		unit := c.Unit
		if unit == "" && c.As == "a" {
			unit = "V"
		}
		meta := map[string]any{"rule": r.ID, "channel": c.ID, "value": v}
		if err != nil && prevResult != result {
			a.log("automation.failed", true, c.Node, fmt.Sprintf("Rule '%s' could not act: %s", r.Name, err), meta)
		} else if flipped && err == nil {
			what := "no action"
			if target != nil {
				what = target.describe()
			}
			a.log("automation.execution", false, c.Node, fmt.Sprintf("Rule '%s': %s %s %s %s %g is %v, %s", r.Name, c.Label, trimFloat(v), unit, r.Op, r.Threshold, cond, what), meta)
		}
		if flipped || prevResult != result {
			a.changed()
		}
	}
}

func trimFloat(v float64) string { return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.4f", v), "0"), ".") }

func (a *app) hookLoop(ctx context.Context) {
	client := &http.Client{Timeout: 5 * time.Second}
	for {
		select {
		case <-ctx.Done():
			return
		case j := <-a.eng.hooks:
			code, msg := a.deliver(ctx, client, j)
			a.store.update(func(st *state) error {
				if i := slices.IndexFunc(st.Webhooks, func(w webhook) bool { return w.ID == j.id }); i >= 0 {
					st.Webhooks[i].LastAt, st.Webhooks[i].LastCode, st.Webhooks[i].LastErr = time.Now(), code, msg
				}
				return nil
			})
			a.changed()
		}
	}
}

func (a *app) deliver(ctx context.Context, client *http.Client, j hookJob) (int, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, j.url, bytes.NewReader(j.body))
	if err != nil {
		return 0, err.Error()
	}
	m := hmac.New(sha256.New, []byte(j.key))
	m.Write(j.body)
	req.Header.Set("content-type", "application/json")
	req.Header.Set("user-agent", "synapse-dashboard/"+version)
	req.Header.Set("x-synapse-event", j.kind)
	req.Header.Set("x-synapse-signature", "sha256="+hex.EncodeToString(m.Sum(nil)))
	res, err := client.Do(req)
	if err != nil {
		return 0, err.Error()
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		return res.StatusCode, res.Status
	}
	return res.StatusCode, ""
}

func (a *app) pruneLoop(ctx context.Context) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		a.store.prune()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
