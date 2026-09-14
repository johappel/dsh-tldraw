---
name: tldraw-plugin
description: tldraw 3.x in DSH-Plugins einbetten — verifizierte API-Fakten (richText, Arrow-Props, Bindings, Reparenting, Frames), Crash-Vermeidung, Persistenz, und die DSH-Slot/Tool-Integration. Nutzen, wenn ein Plugin tldraw-Canvas programmatisch steuert, Zettel/Cluster/Pfeile erzeugt, Frames reparentet oder tldraw-Crashes diagnostiziert.
---

# tldraw-in-DSH Kochbuch (verifiziert gegen tldraw 3.15.6)

Alle Punkte wurden im DSH-Spike `tldraw-3` (2026, Session-Ordner `F:\code\dsh-tldraw`) durch echte Fehler gelernt. Quelle der Belege: `F:\code\dsh-tldraw\docs\SPIKE-REPORT.md`.

## 1. Shape-Props (häufigste Crash-Quelle)

- **Notiz-Text** ist `props.richText` — ein TipTap-Doc, nicht `props.text`:
  ```js
  props: { color: 'light-violet', richText: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Idee' }] }
  ]}}
  ```
- **Pfeil-Label** bleibt plain: `props.text = 'dann'`. `richText` am Pfeil → Validierungs-Crash.
- **Pfeil-Geometrie**: `props.start`/`props.end` sind schlicht `{x, y}` (relativ zur Arrow-Shape-Position). Ein `{type:'point', x, y}`-Wrapper → Crash.
- Text **lesen**: rekursiv über `richText.content` laufen (`node.text` sammeln), Fallback auf `props.text` (Pfeile).

## 2. Crashes verstehen & containen

- Jeder Schema-Verstoß in `createShapes`/`updateShapes` wirft aus `editor.store.put` und **crasht die komplette Seite** (tldraw-Crash-Overlay „Something went wrong"). „Reset data" NICHT klicken — IndexedDB-Persistenz ist intakt, nur neu laden.
- Jeder programmatische Befehl: `try { exec } catch { protokollieren }` — ein Befehl darf nie den Poll-Loop töten.
- Vor jedem Poll: `if (editor.getCrashingError && editor.getCrashingError()) return;`
- Befehle als **einfacher `editor.run(fn)`** — `{history:'once'}` kollidiert in 3.15.6 mit dem History-Interceptor (Crash in `addHistoryInterceptor`).

## 3. Frames & Cluster

- Frame immer als **Hintergrund**: `editor.sendToBack([frame.id])` — **niemals** die Zettel nach hinten (sonst verdeckt der Frame seinen Inhalt).
- Frame-Props: `{ w, h, name }`; Cluster-Titel in `meta.clusterTitle` spiegeln (Snapshot liest beide).
- **Delete-Kaskade**: Ein Frame löscht seine Kinder mit. Deshalb: Vorschlags-Frames sind NIE Eltern; Elternschaft erst bei „Übernehmen".
- Membership-Read: Zentrum des Zettels im Frame-Rechteck (geometrisch) **oder** `shape.parentId === frame.id` (strukturell — bevorzugt).

## 4. Reparenting (strukturelle Membership)

```js
// WICHTIG: Position NACH dem Verschieben frisch lesen (stale refs!)
editor.updateShapes([{
  id: note.id, type: 'note', parentId: frame.id,
  x: fresh.x - frame.x, y: fresh.y - frame.y,  // Frame-Lokalkoordinaten!
  meta: { ...note.meta }
}]);
```
- Zettel zuerst auf Zielpunkt verschieben (Seitenkoordinaten), dann reparenten; im selben `editor.run`-Batch.
- Folgeschritte (Bounds-Union, Pfeil-Zentren) mit `editor.getShape(id)` frisch holen.

## 5. Echte Pfeil-Bindungen

```js
editor.createBindings([
  { fromId: arrowId, toId: fromShapeId, type: 'arrow',
    props: { terminal: 'start', normalizedAnchor: {x:.5,y:.5}, isPrecise:false, isExact:false } },
  { fromId: arrowId, toId: toShapeId, type: 'arrow',
    props: { terminal: 'end',   normalizedAnchor: {x:.5,y:.5}, isPrecise:false, isExact:false } }
]);
```
- `isPrecise:false` zielt auf die Mitte, stoppt am Rand. Der Pfeil folgt dann beiden Shapes.
- Bindings **lesen** (`editor.getBindingsFromShape`) ist in 3.15.6 nicht verlässlich — Bindungs-Test visuell (Zettel verschieben), nicht per API.

## 6. Persistenz & Multi-Page

- `persistenceKey` (IndexedDB) überlebt Reloads und Crashes — bei Crash-Overlay **nur Refresh**.
- Session-scoped Key (`dsh-whiteboard-<sessionId>`) vs. Kontext-loses Mount (Panel): falscher Key = leeres Board. Zuverlässige Quelle: **Host** — Session-Id aus Tool-`exec.agent.id` cachen und dem Client per RPC geben.
- Zwei Tldraw-Instanzen auf einem Key syncen nicht live → genau eine Instanz (globales Host-Div, `appendChild`-Umhängen, nie React-Unmount auf tldraw-DOM).
- `editor.getCurrentPageShapes()` = nur aktive Seite; `pageCount`/`getPage` für Seiten-Metadaten. Gezielter Schreibzugriff auf inaktive Seiten ist nicht trivial.

## 7. Laden im Browser (CDN/ESM, ohne Bundler)

```js
var importFn = new Function('u', 'return import(u)');  // dynamischer Import ohne Literal
Promise.all([
  importFn('https://esm.sh/react@18.3.1'),
  importFn('https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1,react-dom@18.3.1'),
  importFn('https://esm.sh/tldraw@3.15.6?deps=react@18.3.1,react-dom@18.3.1')
]);
// CSS als <link rel=stylesheet href="https://unpkg.com/tldraw@3.15.6/tldraw.css">
```
- React **zweimal** im DOM ist okay: DSH-UI rendert mit dem DSH-React, das Board im eigenen Root mit dem esm.sh-React.

## 8. DSH-Integration

### 8.1 Rechte Sidebar (aktuelle DSH-Version — der richtige Ort fürs Board)

`conversation.view` und `details` existieren **nicht mehr**. Aktueller Baum: `root → shell.overlay | sidebar | main | rightbar`. Eigenes Board als Sidebar-Tab:

```js
// Stage 1: Typ (ctx.sidebarRightTabs), Stage 2: keyed Körper unter derselben id
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: 'dsh-whiteboard', kind: 'whiteboard', priority: 'extension',
  title: () => '🧩 Whiteboard',
  guide: [{ order: 30, title: () => '🧩 Whiteboard', description: () => '…' }],
}), 'type')
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: 'dsh-whiteboard' }, BoardBody,
)), 'body')
ctx.sidebarRight.openTab('whiteboard')   // expandiert die Spalte
```

- **Der Körper bekommt `sessionId` als Standard-Prop** → Persistenz-Key direkt daraus: `'dsh-whiteboard-' + props.sessionId`. Kein Session-Raten nötig.
- Der Client muss `inject: ['slots', 'sidebarRightTabs', 'sidebarRight']` deklarieren, sonst läuft `apply` vor dem Sidebar-Paket und registriert still nichts.
- Fester Öffner zusätzlich als Chip in `shell.overlay` (list, root) — die Guide-Kachel allein versteckt das Board hinter der Guide-Seite.
- Spaltenbreite/Docking macht das Kit selbst (`split`, `float`, Fullscreen) — **kein** eigener Breiten-Griff nötig.

### 8.2 Mount-Timing (der teuerste Crash)

`measureElementTextNodeSpans … can't access property "top", m is undefined` beim Hover = tldraw wurde in einen **0-px- oder `display:none`-Container** gemountet (z. B. geschlossene Spalte, inaktiver Tab). Fix im Client:

```js
// erst mounten, wenn der Container echte Maße hat
if (el.getBoundingClientRect().width >= 80 && el.getBoundingClientRect().height >= 80) initBoard(key);
else setTimeout(retry, 120);   // Mess-Schleife, gedeckelt
```

Verwandt: **nie** den tldraw-DOM-Baum per React-Unmount verschieben. **Ein** globales Host-`<div>` erzeugen, `createRoot` einmal darauf, und das Div per `appendChild` zwischen Seats umhängen — React fasst es nie an (`removeChild`-Crash vermieden).

### 8.3 Tools und RPC je Plugin-Art

| | Dynamisches Cordis-Plugin | Statisches Paket |
|---|---|---|
| Tools | `harness.defineTool(def)` **dann** `harness.registerTool(ctx, def)` | `ctx.get('tools').register(def)` (Disposer in `ctx.effect`) |
| Client→Host | `harness.handle(method, fn)` ↔ `host.call(method, args)` | eigene `webServer`-Route + `fetch`, JSON-Dispatch |
| Timer im Client | Service `timer` (`ctx.interval`) | echte Browser-Timer (`setInterval`) |

Beides gemeinsam: Tool-`parameters` mit **offenem Root** (kein `additionalProperties:false`), Pflichtfelder im `execute`-Body prüfen, **kein `undefined`** über JSON-Grenzen, Session-Id aus `execute(args, exec)` via `exec.agent.id`.

### 8.4 Bindungen und Diagnose

- `editor.createBindings([...])` legt echte Bindungen an (Pfeile folgen den Shapes).
- **Lesen ist versionsabhängig**: `editor.getBindingsFromShape` fehlt in 3.15.6 teils → `bound` fälschlich `false`. Belastbar: Store-Scan
  ```js
  var recs = editor.store.allRecords();
  var n = 0;
  for (var i = 0; i < recs.length; i++) if (recs[i].typeName === 'binding' && recs[i].fromId === arrowId) n++;
  ```
- Nach dem Anlegen einmal nachzählen und bei `0` sichtbar warnen — sonst bleibt ein stiller Fehlschlag unbemerkt.
- Crash-Diagnose im dynamischen Modus: `cordis_inspect_self(pluginId, packageId)` → Phase `client-render`; Run-Cards starten **immer die alte Package-Version** — aktuelle Version nur über die neueste Run-Card oder `cordis_run update`.

### 8.5 Verifikation „läuft das Plugin überhaupt?"

1. Host-Hälfte: Tools per Host-Inspect (`Tool.listTools`) prüfen.
2. Client-Hälfte: Browser-Konsole nach dem eigenen Tag filtern (`[dsh-whiteboard] …`); fehlt die Meldung ganz, wurde das Bundle nicht geladen, steht „… nicht verfügbar", fehlt ein Service (`inject` ergänzen).
3. Ende-zu-Ende: `whiteboard_state` aufrufen — `live:true` beweist, dass eine Browser-Instanz pollt und den Canvas liest.

### 8.6 Agenten-Trigger und zurückhaltende Panels

- Ein Board-Plugin kann den Agenten **nicht selbst** starten — Board-Änderungen lösen keinen Turn aus. Verlässlicher Weg: Standard-Prop `inputActions` aus dem Tab-Body, `inputActions.setDraft(prompt)` und ~60 ms später `inputActions.submit()`.
- Trigger-Buttons gehören in die **Kopfzeile** des Boards, nicht ins Seitenpanel — so bleiben die Aktionen immer erreichbar und das Panel bleibt reiner Inhalt.
- Seitenpanel standardmäßig **aus** und nur bei Agentenaktionen kurz zeigen: `panelOpenFlag` (Mensch heftet an) + `panelAutoUntil` (Auto-Fenster, z. B. 5 s); sichtbar = `flag || Date.now() < autoUntil`. Nach Ablauf ein `pushUi()` per Timer planen, sonst rendert nichts neu und das Panel bleibt stehen; manuelles Umschalten setzt `panelAutoUntil = 0`.
- Die Auto-Einblendung an der **soeben ausgeführten Aktion** festmachen, nicht am Ersteller des Objekts: nur ein tatsächlich ausgeführter Agentenbefehl (nicht ein replayed Ack) blendet ein; jede menschliche Mutation bleibt still. Ein Snapshot-Diff über `n.actor === 'agent' || n.movedBy === 'agent'` ist dafür **falsch** — ein Mensch, der einen zuvor vom Renderer erzeugten Zettel verschiebt, trägt weiterhin den Agenten-Akteur und würde das Panel grundlos aufreißen. Der Diff darf den Suffix „ (Agent)" für die Attribution führen, die Einblendung aber nur aus dem Aktionskontext ableiten.
