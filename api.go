package main

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

func (a *app) role(min string, h func(http.ResponseWriter, *http.Request, session)) http.HandlerFunc {
	return a.signedIn(func(w http.ResponseWriter, r *http.Request, s session) {
		if roleRank[s.Role] < roleRank[min] {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "your role (" + s.Role + ") cannot do that; it needs " + min})
			return
		}
		h(w, r, s)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func bad(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": msg})
}

func decode(r *http.Request, v any) error {
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(v); err != nil {
		return errors.New("the body must be JSON")
	}
	return nil
}

var (
	pinRe  = regexp.MustCompile(`^[A-Za-z0-9_]{1,16}$`)
	nodeRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)
	ops    = []string{">", ">=", "<", "<=", "==", "!="}
	events = []string{"all", "alert", "node.joined", "node.dropped", "device.new", "automation.execution", "automation.failed"}
)

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = s[:n]
	}
	return s
}

type channelView struct {
	channel
	Error    string    `json:"error,omitempty"`
	Readings []reading `json:"readings"`
}

func (a *app) apiState(w http.ResponseWriter, r *http.Request, s session) {
	st := a.store.snapshot()
	var live snapshot
	if cur := a.live.current(); cur != nil {
		json.Unmarshal(cur, &live)
	}
	a.eng.mu.Lock()
	errs := map[string]string{}
	for k, v := range a.eng.chanErr {
		errs[k] = v
	}
	a.eng.mu.Unlock()
	chans := []channelView{}
	for _, c := range st.Channels {
		rs := a.store.recent(c.ID)
		if len(rs) > 150 {
			rs = rs[len(rs)-150:]
		}
		chans = append(chans, channelView{channel: c, Error: errs[c.ID], Readings: rs})
	}
	audit := st.Audit
	if len(audit) > 300 {
		audit = audit[len(audit)-300:]
	}
	out := map[string]any{
		"me":        map[string]string{"name": s.Name, "role": s.Role, "source": s.Source},
		"version":   version,
		"hub":       live,
		"hub_url":   a.cfg.hubURL,
		"nodes_url": a.nodesURL(r),
		"hub_image": env("SYNAPSE_HUB_IMAGE", "ghcr.io/synapse-control/hub:0.3"),
		"devices":   st.Devices,
		"channels":  chans,
		"rules":     st.Rules,
		"settings":  st.Settings,
		"audit":     audit,
		"unseen":    a.store.unseen(s.Name),
	}
	if s.Role == roleAdmin {
		out["webhooks"] = st.Webhooks
		out["node_key"] = a.hub.nodeKey()
		users := []map[string]string{}
		for _, u := range a.users.list() {
			users = append(users, map[string]string{"name": u.Name, "role": u.Role})
		}
		out["users"] = users
		out["local_login"] = a.cfg.localLogin
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *app) apiDeviceEdit(w http.ResponseWriter, r *http.Request, s session) {
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := decode(r, &in); err != nil {
		bad(w, err.Error())
		return
	}
	node := r.PathValue("node")
	err := a.store.update(func(st *state) error {
		i := slices.IndexFunc(st.Devices, func(d device) bool { return d.Node == node })
		if i < 0 {
			return errors.New("no such device")
		}
		if n := clip(in.Name, 64); n != "" {
			st.Devices[i].Name = n
		}
		st.Devices[i].Description = clip(in.Description, 280)
		return nil
	})
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	a.log("device.edited", false, node, fmt.Sprintf("%s renamed or described %s", s.Name, node), nil)
	a.changed()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) apiDeviceForget(w http.ResponseWriter, r *http.Request, s session) {
	node := r.PathValue("node")
	var online bool
	a.store.read(func(st *state) {
		if i := slices.IndexFunc(st.Devices, func(d device) bool { return d.Node == node }); i >= 0 {
			online = st.Devices[i].Online
		}
	})
	if online {
		args, _ := json.Marshal(map[string]string{"node": node})
		status, body, err := a.hub.call(r.Context(), "disconnect_node", true, "user:"+s.Name, args)
		if err != nil || status != http.StatusOK {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "the hub would not disconnect it: " + hubError(status, body, err)})
			return
		}
	}
	var chans, rules int
	var gone []string
	a.store.update(func(st *state) error {
		st.Devices = slices.DeleteFunc(st.Devices, func(d device) bool { return d.Node == node })
		for _, c := range st.Channels {
			if c.Node == node {
				gone = append(gone, c.ID)
			}
		}
		chans = len(gone)
		st.Channels = slices.DeleteFunc(st.Channels, func(c channel) bool { return c.Node == node })
		n := len(st.Rules)
		st.Rules = slices.DeleteFunc(st.Rules, func(x rule) bool {
			return slices.Contains(gone, x.Channel) || x.Then.Node == node || (x.Else != nil && x.Else.Node == node)
		})
		rules = n - len(st.Rules)
		return nil
	})
	for _, id := range gone {
		a.store.forgetChannel(id)
	}
	a.log("device.forgotten", false, node, fmt.Sprintf("%s forgot %s with %d channels and %d rules", s.Name, node, chans, rules), nil)
	a.changed()
	writeJSON(w, http.StatusOK, map[string]int{"channels": chans, "rules": rules})
}

func (in *channel) check() error {
	in.Node, in.Pin, in.Label, in.Unit = clip(in.Node, 64), clip(in.Pin, 16), clip(in.Label, 48), clip(in.Unit, 12)
	if !nodeRe.MatchString(in.Node) || !pinRe.MatchString(in.Pin) {
		return errors.New("pick a device and a pin")
	}
	if in.As != "a" && in.As != "d" {
		return errors.New("read as analog (a) or digital (d)")
	}
	if in.IntervalMs < 250 || in.IntervalMs > 3_600_000 {
		return errors.New("the polling interval is 250 ms to 1 hour")
	}
	if in.Scale == 0 {
		in.Scale = 1
	}
	if math.IsNaN(in.Scale) || math.IsInf(in.Scale, 0) || math.IsNaN(in.Offset) || math.IsInf(in.Offset, 0) {
		return errors.New("scale and offset must be numbers")
	}
	if in.Label == "" {
		in.Label = in.Node + " " + in.Pin
	}
	return nil
}

func (a *app) apiChannelAdd(w http.ResponseWriter, r *http.Request, s session) {
	var in channel
	if err := decode(r, &in); err != nil {
		bad(w, err.Error())
		return
	}
	if err := in.check(); err != nil {
		bad(w, err.Error())
		return
	}
	in.ID, in.Created = newID("ch"), time.Now()
	err := a.store.update(func(st *state) error {
		if len(st.Channels) >= 64 {
			return errors.New("64 channels is the limit")
		}
		st.Channels = append(st.Channels, in)
		return nil
	})
	if err != nil {
		bad(w, err.Error())
		return
	}
	a.log("channel.added", false, in.Node, fmt.Sprintf("%s started recording %s (%s %s) every %d ms", s.Name, in.Label, in.Node, in.Pin, in.IntervalMs), nil)
	a.changed()
	writeJSON(w, http.StatusCreated, in)
}

func (a *app) apiChannelEdit(w http.ResponseWriter, r *http.Request, s session) {
	id := r.PathValue("id")
	var in channel
	if err := decode(r, &in); err != nil {
		bad(w, err.Error())
		return
	}
	err := a.store.update(func(st *state) error {
		i := slices.IndexFunc(st.Channels, func(c channel) bool { return c.ID == id })
		if i < 0 {
			return errors.New("no such channel")
		}
		c := st.Channels[i]
		in.ID, in.Node, in.Pin, in.As, in.Created = c.ID, c.Node, c.Pin, c.As, c.Created
		if err := in.check(); err != nil {
			return err
		}
		st.Channels[i] = in
		return nil
	})
	if err != nil {
		bad(w, err.Error())
		return
	}
	a.log("channel.edited", false, in.Node, fmt.Sprintf("%s set %s to every %d ms", s.Name, in.Label, in.IntervalMs), nil)
	a.changed()
	writeJSON(w, http.StatusOK, in)
}

func (a *app) apiChannelDelete(w http.ResponseWriter, r *http.Request, s session) {
	id := r.PathValue("id")
	var label, node string
	err := a.store.update(func(st *state) error {
		for _, x := range st.Rules {
			if x.Channel == id {
				return fmt.Errorf("rule '%s' reads this channel; delete the rule first", x.Name)
			}
		}
		i := slices.IndexFunc(st.Channels, func(c channel) bool { return c.ID == id })
		if i < 0 {
			return errors.New("no such channel")
		}
		label, node = st.Channels[i].Label, st.Channels[i].Node
		st.Channels = slices.Delete(st.Channels, i, i+1)
		return nil
	})
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	a.store.forgetChannel(id)
	a.log("channel.removed", false, node, fmt.Sprintf("%s stopped recording %s", s.Name, label), nil)
	a.changed()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (o *output) check() error {
	o.Node, o.Pin = clip(o.Node, 64), clip(o.Pin, 16)
	if !nodeRe.MatchString(o.Node) || !pinRe.MatchString(o.Pin) {
		return errors.New("the action needs a device and a pin")
	}
	switch o.Mode {
	case "high", "low":
		o.Duty, o.Hz = 0, 0
	case "pwm":
		if o.Duty < 0 || o.Duty > 1 || o.Hz < 0 || o.Hz > 40000 {
			return errors.New("PWM duty is 0 to 1 and the frequency up to 40 kHz")
		}
	default:
		return errors.New("the action sets the pin high, low or to a PWM duty")
	}
	return nil
}

type ruleInput struct {
	Name      string  `json:"name"`
	Template  string  `json:"template"`
	Channel   string  `json:"channel"`
	Op        string  `json:"op"`
	Threshold float64 `json:"threshold"`
	Then      output  `json:"then"`
	Else      *output `json:"else"`
	Enabled   *bool   `json:"enabled"`
}

func (in *ruleInput) check(st *state) error {
	in.Name, in.Template = clip(in.Name, 64), clip(in.Template, 32)
	if in.Name == "" {
		return errors.New("name the rule")
	}
	if !slices.ContainsFunc(st.Channels, func(c channel) bool { return c.ID == in.Channel }) {
		return errors.New("pick a channel for the rule to watch")
	}
	if !slices.Contains(ops, in.Op) {
		return errors.New("pick a comparison")
	}
	if math.IsNaN(in.Threshold) || math.IsInf(in.Threshold, 0) {
		return errors.New("the threshold must be a number")
	}
	if err := in.Then.check(); err != nil {
		return err
	}
	if in.Else != nil {
		if err := in.Else.check(); err != nil {
			return errors.New("otherwise: " + err.Error())
		}
	}
	return nil
}

func (a *app) apiRuleAdd(w http.ResponseWriter, r *http.Request, s session) {
	var in ruleInput
	if err := decode(r, &in); err != nil {
		bad(w, err.Error())
		return
	}
	var out rule
	err := a.store.update(func(st *state) error {
		if err := in.check(st); err != nil {
			return err
		}
		if len(st.Rules) >= 64 {
			return errors.New("64 rules is the limit")
		}
		out = rule{ID: newID("rule"), Name: in.Name, Template: in.Template, Channel: in.Channel, Op: in.Op, Threshold: in.Threshold,
			Then: in.Then, Else: in.Else, Enabled: true, Version: 1, Created: time.Now(), By: s.Name}
		st.Rules = append(st.Rules, out)
		return nil
	})
	if err != nil {
		bad(w, err.Error())
		return
	}
	a.log("automation.created", false, out.Then.Node, fmt.Sprintf("%s created rule '%s'", s.Name, out.Name), map[string]any{"rule": out.ID})
	a.changed()
	writeJSON(w, http.StatusCreated, out)
}

func (a *app) apiRuleEdit(w http.ResponseWriter, r *http.Request, s session) {
	id := r.PathValue("id")
	var in ruleInput
	if err := decode(r, &in); err != nil {
		bad(w, err.Error())
		return
	}
	var out rule
	err := a.store.update(func(st *state) error {
		i := slices.IndexFunc(st.Rules, func(x rule) bool { return x.ID == id })
		if i < 0 {
			return errors.New("no such rule")
		}
		x := &st.Rules[i]
		if in.Name == "" && in.Enabled != nil {
			x.Enabled = *in.Enabled
			x.State = nil
			out = *x
			return nil
		}
		if err := in.check(st); err != nil {
			return err
		}
		x.Name, x.Template, x.Channel, x.Op, x.Threshold, x.Then, x.Else = in.Name, in.Template, in.Channel, in.Op, in.Threshold, in.Then, in.Else
		if in.Enabled != nil {
			x.Enabled = *in.Enabled
		}
		x.Version++
		x.State = nil
		out = *x
		return nil
	})
	if err != nil {
		bad(w, err.Error())
		return
	}
	verb := "edited"
	if in.Name == "" {
		verb = map[bool]string{true: "enabled", false: "disabled"}[out.Enabled]
	}
	a.log("automation."+verb, false, out.Then.Node, fmt.Sprintf("%s %s rule '%s'", s.Name, verb, out.Name), map[string]any{"rule": out.ID})
	a.changed()
	writeJSON(w, http.StatusOK, out)
}

func (a *app) apiRuleDelete(w http.ResponseWriter, r *http.Request, s session) {
	id := r.PathValue("id")
	var name string
	a.store.update(func(st *state) error {
		if i := slices.IndexFunc(st.Rules, func(x rule) bool { return x.ID == id }); i >= 0 {
			name = st.Rules[i].Name
			st.Rules = slices.Delete(st.Rules, i, i+1)
		}
		return nil
	})
	if name != "" {
		a.log("automation.deleted", false, "", fmt.Sprintf("%s deleted rule '%s'", s.Name, name), nil)
		a.changed()
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) apiSimulate(w http.ResponseWriter, r *http.Request, s session) {
	var in ruleInput
	if err := decode(r, &in); err != nil {
		bad(w, err.Error())
		return
	}
	var c channel
	var found bool
	a.store.read(func(st *state) {
		if i := slices.IndexFunc(st.Channels, func(x channel) bool { return x.ID == in.Channel }); i >= 0 {
			c, found = st.Channels[i], true
		}
	})
	if !found {
		bad(w, "pick a channel for the rule to watch")
		return
	}
	v, e, err := a.measure(r.Context(), c)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "could not read " + c.Label + ": " + err.Error()})
		return
	}
	cond := compare(v, in.Op, in.Threshold)
	would := "do nothing"
	if cond && in.Then.Node != "" {
		would = "set " + in.Then.describe()
	} else if !cond && in.Else != nil {
		would = "set " + in.Else.describe()
	}
	writeJSON(w, http.StatusOK, map[string]any{"value": v, "err": e, "unit": c.Unit, "label": c.Label, "met": cond, "would": would})
}

var ranges = map[string]time.Duration{"15m": 15 * time.Minute, "1h": time.Hour, "6h": 6 * time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}

func (a *app) historyFor(r *http.Request) (channel, []reading, error) {
	id := r.URL.Query().Get("channel")
	span, ok := ranges[r.URL.Query().Get("range")]
	if !ok {
		span = time.Hour
	}
	var c channel
	var found bool
	a.store.read(func(st *state) {
		if i := slices.IndexFunc(st.Channels, func(x channel) bool { return x.ID == id }); i >= 0 {
			c, found = st.Channels[i], true
		}
	})
	if !found {
		return c, nil, errors.New("no such channel")
	}
	now := time.Now()
	return c, a.store.history(id, now.Add(-span), now), nil
}

func (a *app) apiHistory(w http.ResponseWriter, r *http.Request, s session) {
	c, rs, err := a.historyFor(r)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	type point struct {
		T   int64   `json:"t"`
		V   float64 `json:"v"`
		Min float64 `json:"min"`
		Max float64 `json:"max"`
	}
	pts := []point{}
	const buckets = 400
	step := 1
	if len(rs) > buckets {
		step = (len(rs) + buckets - 1) / buckets
	}
	var sum float64
	lo, hi := math.Inf(1), math.Inf(-1)
	for i := 0; i < len(rs); i += step {
		p := point{T: rs[i].T, Min: math.Inf(1), Max: math.Inf(-1)}
		var bs float64
		n := 0
		for _, x := range rs[i:min(i+step, len(rs))] {
			bs += x.V
			n++
			p.Min, p.Max = math.Min(p.Min, x.V), math.Max(p.Max, x.V)
		}
		p.V = round4(bs / float64(n))
		pts = append(pts, p)
	}
	for _, x := range rs {
		sum += x.V
		lo, hi = math.Min(lo, x.V), math.Max(hi, x.V)
	}
	stats := map[string]any{"n": len(rs)}
	if len(rs) > 0 {
		stats["min"], stats["max"], stats["mean"] = lo, hi, round4(sum/float64(len(rs)))
	}
	writeJSON(w, http.StatusOK, map[string]any{"channel": c, "points": pts, "stats": stats})
}

func (a *app) apiHistoryCSV(w http.ResponseWriter, r *http.Request, s session) {
	c, rs, err := a.historyFor(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	name := regexp.MustCompile(`[^A-Za-z0-9_-]+`).ReplaceAllString(c.Label, "-")
	w.Header().Set("content-type", "text/csv; charset=utf-8")
	w.Header().Set("content-disposition", `attachment; filename="`+name+`.csv"`)
	cw := csv.NewWriter(w)
	cw.Write([]string{"time", "node", "pin", "value", "uncertainty", "unit"})
	for _, x := range rs {
		cw.Write([]string{time.UnixMilli(x.T).UTC().Format(time.RFC3339Nano), c.Node, c.Pin, strconv.FormatFloat(x.V, 'f', -1, 64), strconv.FormatFloat(x.E, 'f', -1, 64), c.Unit})
	}
	cw.Flush()
}

func (a *app) apiSettings(w http.ResponseWriter, r *http.Request, s session) {
	var in settings
	if err := decode(r, &in); err != nil {
		bad(w, err.Error())
		return
	}
	if in.RetentionDays < 1 || in.RetentionDays > 3650 {
		bad(w, "keep data for 1 to 3650 days")
		return
	}
	a.store.update(func(st *state) error { st.Settings = in; return nil })
	go a.store.prune()
	a.log("settings.changed", false, "", fmt.Sprintf("%s set data retention to %d days", s.Name, in.RetentionDays), nil)
	a.changed()
	writeJSON(w, http.StatusOK, in)
}

func (a *app) apiSeen(w http.ResponseWriter, r *http.Request, s session) {
	a.store.update(func(st *state) error { st.Seen[s.Name] = time.Now(); return nil })
	writeJSON(w, http.StatusOK, map[string]int{"unseen": 0})
}

func (a *app) apiHookAdd(w http.ResponseWriter, r *http.Request, s session) {
	var in webhook
	if err := decode(r, &in); err != nil {
		bad(w, err.Error())
		return
	}
	u, err := url.Parse(strings.TrimSpace(in.URL))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		bad(w, "the webhook needs an http or https URL")
		return
	}
	if !slices.Contains(events, in.Event) {
		bad(w, "pick an event")
		return
	}
	h := webhook{ID: newID("wh"), URL: u.String(), Event: in.Event, Enabled: true, Secret: newID("whsec")}
	err = a.store.update(func(st *state) error {
		if len(st.Webhooks) >= 16 {
			return errors.New("16 webhooks is the limit")
		}
		st.Webhooks = append(st.Webhooks, h)
		return nil
	})
	if err != nil {
		bad(w, err.Error())
		return
	}
	a.log("webhook.added", false, "", fmt.Sprintf("%s added a webhook for %s to %s", s.Name, h.Event, u.Host), nil)
	a.changed()
	writeJSON(w, http.StatusCreated, h)
}

func (a *app) apiHookEdit(w http.ResponseWriter, r *http.Request, s session) {
	id := r.PathValue("id")
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if err := decode(r, &in); err != nil {
		bad(w, err.Error())
		return
	}
	a.store.update(func(st *state) error {
		if i := slices.IndexFunc(st.Webhooks, func(h webhook) bool { return h.ID == id }); i >= 0 {
			st.Webhooks[i].Enabled = in.Enabled
		}
		return nil
	})
	a.changed()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) apiHookDelete(w http.ResponseWriter, r *http.Request, s session) {
	id := r.PathValue("id")
	a.store.update(func(st *state) error {
		st.Webhooks = slices.DeleteFunc(st.Webhooks, func(h webhook) bool { return h.ID == id })
		return nil
	})
	a.changed()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *app) apiHookTest(w http.ResponseWriter, r *http.Request, s session) {
	id := r.PathValue("id")
	var h webhook
	var found bool
	a.store.read(func(st *state) {
		if i := slices.IndexFunc(st.Webhooks, func(x webhook) bool { return x.ID == id }); i >= 0 {
			h, found = st.Webhooks[i], true
		}
	})
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such webhook"})
		return
	}
	body, _ := json.Marshal(map[string]any{"event": "test", "time": time.Now(), "message": "A test from the Synapse Control dashboard, sent by " + s.Name})
	code, msg := a.deliver(r.Context(), &http.Client{Timeout: 5 * time.Second}, hookJob{id: h.ID, url: h.URL, key: h.Secret, kind: "test", body: body})
	a.store.update(func(st *state) error {
		if i := slices.IndexFunc(st.Webhooks, func(x webhook) bool { return x.ID == id }); i >= 0 {
			st.Webhooks[i].LastAt, st.Webhooks[i].LastCode, st.Webhooks[i].LastErr = time.Now(), code, msg
		}
		return nil
	})
	a.changed()
	writeJSON(w, http.StatusOK, map[string]any{"code": code, "error": msg})
}

func (a *app) apiUserAdd(w http.ResponseWriter, r *http.Request, s session) {
	var in struct {
		Name     string `json:"name"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if err := decode(r, &in); err != nil {
		bad(w, err.Error())
		return
	}
	if err := a.users.add(strings.TrimSpace(in.Name), in.Password, in.Role, false); err != nil {
		bad(w, err.Error())
		return
	}
	a.log("people.added", false, "", fmt.Sprintf("%s added %s as %s", s.Name, in.Name, in.Role), nil)
	a.changed()
	writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
}

func (a *app) apiUserDelete(w http.ResponseWriter, r *http.Request, s session) {
	name := r.PathValue("name")
	if err := a.users.remove(name); err != nil {
		bad(w, err.Error())
		return
	}
	a.log("people.removed", false, "", fmt.Sprintf("%s removed %s", s.Name, name), nil)
	a.changed()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
