# dsh-whiteboard

Gemeinsames tldraw-Whiteboard für DeepSeek Harness (DSH) — als **Tab in der rechten Sidebar**, mit 9 kontrollierten Agenten-Tools für Brainstorming und Clustern.

> Aus dem Spike hervorgegangen (ursprünglich dynamisches Cordis-Plugin `tldraw-3`/pkg-23). Spike-Bericht: [`../../docs/SPIKE-REPORT.md`](../../docs/SPIKE-REPORT.md). Wiederverwendbarer Skill: `tldraw-plugin`.

## Funktionen

- **Tab-Typ `whiteboard`** in der rechten Sidebar (`ctx.sidebarRightTabs` + keyed `sidebar.right.pane.tab`) — der Konversations-Stream bleibt sichtbar
- **Öffner-Chip „🧩 Board"** unten rechts (`shell.overlay`) sowie eine Kachel auf der Guide-Seite der Sidebar
- **Akteur-Attribution** — Agenten-Zettel violett, `meta.actor`, Badges im Whiteboard-Log, Aktivitätsprotokoll
- **Agenten-Trigger in der Kopfzeile** — `🤖 Dazu fragen` (schickt die aktuelle Auswahl mit, Zähler = Anzahl ausgewählter Zettel), `🔍 Feedback` (kurzes Feedback zu den Änderungen seit dem letzten Feedback, Zähler = offene Änderungen), `🤖 Cluster vorschlagen`, `🤖 Ideen ergänzen`. Technik: Standard-Prop `inputActions` (`setDraft` + `submit`)
- **Änderungs-Tracker** — der Client vergleicht aufeinanderfolgende Snapshots und protokolliert neue/verschobene/geänderte/entfernte Zettel samt Akteur; das Delta steht im Whiteboard-Log und geht in den Feedback-Prompt ein
- **Whiteboard-Log statt Dauer-Panel** — standardmäßig ausgeblendet; nach einer Agentenänderung am Board (oder nach einem Agenten-Turn) blendet es sich ~5 s ein und danach wieder aus. `📋 Log einblenden` heftet es dauerhaft an, `📋 Log ausblenden` löst die Heftung wieder
- **Unverbindliche Vorschläge** — Cluster-Frames und Pfeile sind Vorschläge; „Übernehmen" macht sie strukturell (Reparenting), „Verwerfen" löscht nur den Container
- **Agenten-Tools** (9): `whiteboard_state`, `whiteboard_add_note`, `whiteboard_rename_cluster`, `whiteboard_propose_clusters`, `whiteboard_arrange_sequence`, `whiteboard_connect_notes`, `whiteboard_bind_frame`, `whiteboard_frame_to_back`, `whiteboard_highlight_notes`

## Installation (einmalig pro Rechner)

1. **Junction ins Profil** (PowerShell):

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-whiteboard" -Target "F:\code\dsh-tldraw\plugin\dsh-whiteboard"
```

2. **Patch-Ebene** in `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-whiteboard
      name: dsh-whiteboard
      inject: [webServer]
```

3. **DSH neu starten** (statische Plugins werden nur beim Boot geladen).

**Wichtig:** Keine zweite Whiteboard-Variante parallel betreiben (dynamisches Spike-Plugin vorher `cordis_undefine`), sonst doppelte Slots/Tools.

## Entfernen

Patch-Eintrag löschen, Junction entfernen, DSH neu starten.

## Architektur in Kürze

| Hälfte | Ort | Rolle |
|---|---|---|
| Host | `lib/index.js` (ESM) | HTTP-API `/dsh-whiteboard/api` (`wb-poll`, `wb-snapshot`, `wb-board`, `wb-save`), generischer Snapshot-Store unter `$DSH_HOME/whiteboard-snapshots`, Tool-Registrierung über `tools`-Service |
| Client | `lib/client.js` (Classic Script) | Tab-Typ + Tab-Körper, eine tldraw-3.15.6-Instanz (esm.sh), 450-ms-Polling, Öffner-Chip |

**Registrierung (zweistufig):**

```js
ctx.sidebarRightTabs.register({ id: 'dsh-whiteboard', kind: 'whiteboard', priority: 'extension', title, guide: [...] })
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-whiteboard' }, BoardBody)
ctx.sidebarRight.openTab('whiteboard')
```

Der Client deklariert `inject: ['slots', 'sidebarRightTabs', 'sidebarRight']`, damit er erst angewandt wird, wenn die Sidebar-Services existieren. Der `persistenceKey` bleibt ein browserlokaler Cache; der dauerhafte Stand liegt als vollständiger tldraw-Snapshot im Host-Store. Die Board-ID ist ein opaker Hash des Workspace-Pfads und ist dadurch browser- und sessionübergreifend stabil.

## Bekannte Grenzen

- Der Agent sieht und bearbeitet nur die **aktive** tldraw-Seite (`page.pageCount` meldet weitere).
- Chrome und Firefox teilen den lokalen IndexedDB-Cache nicht; der Host-Store ist deshalb die gemeinsame Persistenzquelle. Bei zwei gleichzeitigen Browsern wird ein Versionskonflikt erkannt und der spätere Stand nicht still überschrieben. Ein vollständiger Live-Sync ist ein eigener Ausbau.
- Pfeil-Bindungen: Erstellung über `editor.createBindings`; das Auslesen ist versionsabhängig, daher prüft der Snapshot zusätzlich per Store-Scan.
- tldraw wird nie in einen unsichtbaren Container gemountet (sonst Text-Mess-Crash).
