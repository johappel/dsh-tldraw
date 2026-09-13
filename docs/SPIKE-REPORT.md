# Spike-Report: Gemeinsames Brainstorming & Clustern auf tldraw (DSH × Agent)

**Plugin:** `dsh-whiteboard` (ursprünglich dynamisch als `tldraw-3`/pkg-23, jetzt statisches Plugin — siehe `plugin/dsh-whiteboard/`)
**Leitfrage:**

> Kann ein Mensch gemeinsam mit einem DSH-Agenten auf derselben tldraw-Fläche brainstormen und clustern, wobei Agentenbeiträge sichtbar, nachvollziehbar und kontrollierbar bleiben?

**Kurzantwort: Ja** — mit klar definierten Grenzen und zwei Architekturwechseln, die im Verlauf erzwungen wurden (DSH-Slot-Umbau, tldraw-Validierungs-Crashes).

---

## 1. Architektur (aktueller Stand)

```
┌──────┬────────────────────────────┬──────────────────────────┐
│ Rail │  Konversation (Stream +    │  rechte Sidebar          │
│      │  Composer)                 │  Tab „🧩 Whiteboard"     │
└──────┴────────────────────────────┴──────────────────────────┘
        + schwebender Chip „🧩 Board" (shell.overlay) als Öffner
```

| Hälfte | Ort | Verantwortung |
|---|---|---|
| **Host** | `lib/index.js` (ESM) | HTTP-API `/dsh-whiteboard/api` (`wb-poll`, `wb-snapshot`, `wb-board`, `wb-save`), 9 Agenten-Tools über den `tools`-Service, Session-Erkennung via `exec.agent.id` |
| **Client** | `lib/client.js` (Classic Script) | Tab-Typ + Tab-Körper, genau **eine** tldraw-5.4.2-Instanz (esm.sh), sessiongebundene Event-Streams und Store-Listener, Öffner-Chip |

**Registrierung (zweistufig, verifiziert gegen DSH-Code und Doku):**

```js
// Stage 1 — der Typ
ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title, guide: [...] })
// Stage 2 — der Körper, keyed unter derselben id
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)
// Öffnen
ctx.sidebarRight.openTab(kind)
```

**Akteur-Modell:** `meta.actor` (`human`/`agent`), Agenten-Zettel violett, Badges im Whiteboard-Log, Aktivitätsprotokoll.
**Verbindlichkeit:** Vorschläge geometrisch und unverbindlich; „Übernehmen" erzeugt Struktur (Reparenting in den Frame), „Verwerfen" löscht nur den Container.

---

## 2. Szenario-Durchlauf (erfolgreich absolviert)

| Schritt | Szenario | Ergebnis |
|---|---|---|
| 1 | Mensch legt Zettel an | ✅ (Themen-Zettel, Methodenvielfalt, Vertiefung, „Das ist ok") |
| 2 | Mensch verschiebt/bearbeitet | ✅ inkl. Korrektur von Agenten-Geometrie durch den Menschen |
| 3 | Agent ergänzt sichtbar | ✅ violette Zettel, Log-Badges, Aktivitätslog |
| 4 | Agent erkennt Zusammenhänge und schlägt Cluster vor | ✅ „Guter Unterricht", „Prozess & Rückmeldung", „Denken & Verstehen", „Beziehung & Klima" |
| 5 | Cluster als Frames | ✅ Frames + (nach Übernahme) echte Elternschaft via `parentId` |
| 6 | Agent hebt hervor / verbindet / arrangiert | ✅ `highlight`, `connect`, `arrange-sequence` (Workflow „Phasen") |
| 7 | Mensch übernimmt/ändert/verwirft | ✅ inkl. Umbenennen, Verwerfen ohne Zettelverlust |
| 8 | Mensch behält Kontrolle | ✅ keine Lösch-/Verschiebegewalt beim Agenten |
| 9 | Mensch fordert Feedback zum Board an | ✅ `🔍 Feedback`-Knopf startet einen Agenten-Turn mit dem Delta seit dem letzten Feedback |

**Leitfragen-Belege:**
- **Derselbe Canvas** ✅ — Agent sieht Verschiebungen im Snapshot, Mensch sieht Agenten-Zettel sofort.
- **Akteur eindeutig** ✅ — Farbe, `meta.actor`, Badges, Log.
- **Agentenbeiträge unterscheidbar** ✅ — violett; `meta.movedBy: 'agent'` bei Umordnungen menschlicher Zettel.
- **Undo/Redo & Zustand konsistent** ✅ — Agentenaktionen sind normale `editor.run`-Schritte; IndexedDB überlebte mehrere Client-Crashes.
- **Kontrollierter Zugriff** ✅ — alles über die 9 Tools; `whiteboard_state.live=false`, wenn kein Client lauscht.
- **Auswahl-Sichtbarkeit** ✅ — der Agent liest die aktuelle Selektion des Menschen (`selection` im Snapshot).

---

## 3. Erkenntnisse, Fehlwege, Korrekturen

### 3.1 Geometrische Membership ist fragil
Cluster aus der Bounding-Box ziehen fremde Zettel hinein (Themen-Zettel wurde mit eingeschlossen). Lösung: `arrange-sequence` (ordnend) statt „Frame um Verstreutes"; strukturelle Membership erst bei Übernahme.

### 3.2 Frames sind Hintergrund
`sendToBack(frame)` — **niemals** `sendToBack(notes)`; sonst verdeckt der Rahmen seinen Inhalt.

### 3.3 tldraw-Validierung crasht die ganze Seite
Falsche Props (`props.text` statt `richText`, `{type:'point'}`-Wrapper, `richText` am Pfeil) werfen aus `createShapes` und zerstören die Seite. Gegenmaßnahmen: try/catch pro Befehl, `editor.getCrashingError()`-Guard, „Refresh statt Reset".

### 3.4 Unsichtbarer Container = Text-Mess-Crash
`measureElementTextNodeSpans … m is undefined` beim Hover, wenn tldraw in einen 0-px/`display:none`-Container gemountet wurde. Fix: **Erst mounten, wenn der Container ≥ 80×80 px hat** (Mess-Schleife).

### 3.5 Zwei Editoren auf einem Persistence-Key
Der Migrations-Hilfseditor darf nie denselben Key wie der Live-Editor öffnen; zusätzlich: Migration nur bei host-bestätigtem, abweichendem Key.

### 3.6 DSH-Slot-Umbau (der große Bruch)
Die ältere DSH-Version hatte `conversation.view` (Tab) und `details` (rechte Spalte). Die aktuelle Version hat beides **entfernt**: `root → shell.overlay | sidebar | main | rightbar`. Der frühere `shell.overlay`-Ansatz (weißes Board über dem Chat) war ein Holzweg — er verdeckt den Stream. Der richtige Baustein ist die **rechte Sidebar** mit Tab-Typen.

### 3.7 Service-Timing im Client
`ctx.get('sidebarRightTabs')` ist beim ersten `apply` oft `undefined`, wenn das Sidebar-Paket später lädt → nichts wird registriert (stiller Fehlschlag). Fix: `inject: ['slots', 'sidebarRightTabs', 'sidebarRight']` — Cordis wartet und wendet erneut an.

### 3.8 Command-Queue × Client-Update
Befehle aus der Warteschlange können während des asynchronen Ladens von React
und tldraw eintreffen. Der aktuelle Client puffert diese Events bis Editor und
Server-Hydration bereit sind. Jeder Befehl trägt eine sessiongebundene
`commandId`; nach der Ausführung meldet der Client diese ID im Folge-Snapshot
als `ok: true` oder `ok: false`. Eine bereits erfolgreiche ID wird bei einer
Nachlieferung idempotent ignoriert. Die generische Queue bleibt damit ein
Transport-Seam, nicht die Erfolgsmeldung.

### 3.9 Knopf-Interaktion: der Agent startet sich nicht selbst
Board-Änderungen lösen **keinen** Agenten-Turn aus — es gibt kein Board-Event, das auf die Konversation wirkt; der **Mensch bleibt der Auslöser**. Verifizierter Weg aus dem Tab-Body heraus: Standard-Prop `inputActions` → `setDraft(prompt)` und ~60 ms später `submit()`. Ein Turn entsteht damit genau so, als hätte der Mensch getippt.

Vier Trigger in der Kopfzeile: `🤖 Dazu fragen` (hängt die aktuelle Auswahl als ` Ausgewählt habe ich: „…“.` an den Prompt), `🔍 Feedback` (schickt das Snapshot-Delta seit dem letzten Feedback), `🤖 Cluster vorschlagen`, `🤖 Ideen ergänzen`. Beide Zähler haben verschiedene Bedeutung: `Dazu fragen (n)` = n ausgewählte Zettel, `Feedback (n)` = n offene Änderungen seit dem letzten Feedback.

### 3.10 Sichtbarkeit der Agentenbeiträge ohne Dauer-Panel
Ein dauerhaftes Seitenpanel dominiert die Fläche, die eigentlich der Canvas braucht. Lösung: Das **Whiteboard-Log** ist standardmäßig aus (`panelOpenFlag`), öffnet sich ~5 s, wenn der Änderungs-Tracker eine **Agenten**änderung erkennt (`showPanelBriefly`, `panelAutoUntil`), und schließt sich dann selbst — der Mensch kann es über `📋 Log einblenden` dauerhaft anheften. Zwei Details waren nötig, damit das trägt: (a) nach Ablauf des Fensters muss ein Timer ein Re-Render anstoßen, sonst bleibt das Log stehen; (b) der Snapshot-Diff muss **akteurssensitiv** sein (`actor`/`movedBy` → Suffix „ (Agent)"), sonst gilt eine Agenten-Verschiebung als neutrale Änderung und die Einblendung unterbleibt. Attribution ist damit sichtbar, ohne Kontrolle abzugeben: nichts passiert unbeobachtet, aber auch nichts ohne Auslöser.

---

## 4. Historische API-Fakten (tldraw 3.15.6)

Die folgenden Detailbefunde stammen aus dem ursprünglichen Spike. Der aktuelle
CDN-Client zielt auf tldraw `5.4.2`; die 5.4.2-Browserabnahme ist separat zu
protokollieren.

- Notiz-Text = `props.richText` (TipTap-Doc) — **nicht** `props.text`
- Pfeil-Label = `props.text` (plain); Pfeil-Geometrie = `props.start/end` als `{x,y}`
- Frames: `props.name`, `sendToBack`, Lösch-Kaskade auf Kinder
- Reparenting: `updateShapes([{ id, type: 'note', parentId: frame.id, x: pageX - frameX, y: pageY - frameY }])` — Shape **nach** dem Verschieben frisch lesen (stale refs!)
- Bindings: `editor.createBindings([{ fromId, toId, type:'arrow', props:{ terminal, normalizedAnchor, isPrecise, isExact } }])`
- `editor.run(fn)` ja; `editor.run(fn, {history:'once'})` kollidierte mit dem History-Interceptor

## 5. Verifizierte DSH-Fakten (aktuelle Version)

- Slots: `shell.overlay` (list, root), `sidebar` (single), `main` (keyed), `rightbar` (single); darunter session-scoped `rightbar.session` und die Sidebar-Seats
- `sidebar.right.pane.tab` (keyed, session) — Standard-Props u. a. `sessionId`, `useSession`, `useResource`; Hook `useTabInfo()`
- `ctx.sidebarRight`: `openTab(kind)`, `openResource(address)`, `close/focus/split/float/dock`, `isExpanded/toggleExpanded`
- `ctx.layout`: `selectPanel`, `openRightbar(track, fullscreen)`, `closeRightbar`, `toggleSidebar` (kein `openDetails` mehr!)
- Tab-Typ-Bänder: `extension` (höchste) | `builtin` | `fallback`
- Agenten-Trigger aus einem Tab-Body: Standard-Prop `inputActions` mit `setDraft(text)` + `submit()` — der Turn läuft wie eine menschliche Eingabe (Auslöser bleibt der Mensch, s. 3.9)

## 6. Tool-Inventar (9 Tools, unverändert)

`whiteboard_state`, `whiteboard_add_note`, `whiteboard_rename_cluster`, `whiteboard_propose_clusters`, `whiteboard_arrange_sequence`, `whiteboard_connect_notes`, `whiteboard_bind_frame`, `whiteboard_frame_to_back`, `whiteboard_highlight_notes`

## 7. Offene Punkte

1. **Pfeil-Bindungen**: per Store-Scan bestätigt (5/5 Pfeile mit `binding`-Records, `getBindingsFromShape` in 3.15.6 unzuverlässig); der visuelle Test (Zettel ziehen → Pfeil folgt) bleibt ein menschlicher Blick.
2. **Browser-E2E für Ack und Nacharbeit:** frühes Event, fehlendes Ack,
   negativer Client-Befehl und sessiongebundene Fremdsession müssen nach dem
   nächsten Neustart live protokolliert werden.
3. **Gezielter Zugriff auf nicht-aktive tldraw-Seiten** (aktuell nur die aktive Seite).
4. **Details-Spaltenbreite**: entfällt — die neue Sidebar bringt Docken/Splitten/Fullscreen selbst mit.
5. **`whiteboard_move_into_frame`**: Zettel, die außerhalb jedes Frames liegen (aktuell 3 Agenten-Zettel rechts von „Guter Unterricht"), in einem Undo-Schritt verschieben **und** reparenten — bisher nur über `arrange-sequence` (legt neu an) oder manuell.
6. **Log-Benennung/UX**: Bezeichnungen (`Whiteboard-Log`) und Auto-Einblendung sind Produktentscheidungen, nicht Architektur — bei Bedarf Feinjustierung der Fensterlänge (aktuell 5 s).
