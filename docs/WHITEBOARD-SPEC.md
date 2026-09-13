# Whiteboard-Spezifikation

## Zweck

`dsh-whiteboard` stellt eine generische, gemeinsame tldraw-Fläche für DSH
bereit. Der Mensch behält die sichtbare Kontrolle; Agentenaktionen werden als
normale, nachvollziehbare Board-Änderungen ausgeführt.

## Laufzeitmodell

```text
DSH session + workspace
        │ sessionId aus exec.agent.id
        ▼
Host: dsh-whiteboard
  ├─ whiteboard_state             (intern)
  ├─ whiteboard_request_open      (intern)
  ├─ whiteboard_render_plan        (intern)
  └─ versionierter Snapshot-Store (workspacegebundene Board-ID)
        ▲ HTTP-API
        │
Browser: shell.overlay opener + rechte Sidebar
  └─ eine tldraw-Instanz, persistenceKey dsh-whiteboard-<sessionId>
```

Die browserlokale IndexedDB ist ein Cache. Der Host-Store ist die gemeinsame
Persistenzquelle für Neustart und Browserwechsel; das ist kein Echtzeit-
Mehrbrowser-Sync. Version/ETag-Konflikte werden geschützt, nicht automatisch
zusammengeführt.

## Öffnen und Reload

Der Opener muss auch bei geschlossener Sidebar im `shell.overlay` leben.

1. Eine semantische Agentenaktion liest `whiteboard_state`.
2. Bei `live=false` ruft der Host intern `whiteboard_request_open` mit der
   Session-ID auf.
3. Der Browser-Opener nimmt nur das passende sessiongebundene Signal an und
   ruft `sidebarRight.openTab('whiteboard')` auf.
4. Der Renderer wartet begrenzt auf den ersten Live-Snapshot und reiht erst
   danach den RenderPlan ein.
5. Ein explizit geöffnetes Board speichert seine Ansicht pro Browser-Origin.
   Beim Reload wird das Öffnen wiederholt, falls der Session-Surface beim
   ersten Render noch nicht gemountet ist.

Ein fehlender oder nicht erreichbarer Browser bleibt nach dem Timeout ein
ehrlicher `blocked`-Zustand; der Agent darf keinen Erfolg behaupten.

## Shape-Schema (tldraw 5.4.2)

- Note-Text: `props.richText` als TipTap-Dokument, nicht `props.text`.
- Pfeil-Label: `props.text`; Geometrie `props.start` und `props.end` als
  `{x, y}`.
- Frames: `{w, h, name}`; Frame-Hintergründe mit `sendToBack` hinter den
  Inhalt legen.
- Bindings mit `editor.createBindings`; das Vorhandensein belastbar per
  Store-Scan prüfen, nicht allein über versionsabhängige Lesehelfer.
- Reparenting in einem `editor.run`-Schritt mit frisch gelesenen Shape-
  Koordinaten. Vorschlags-Frames sind vor der menschlichen Übernahme keine
  Eltern, damit eine Löschung keine Zettel-Kaskade auslöst.
- Keine Mutation in 0×0- oder `display:none`-Containern. Den Editor erst bei
  ausreichender Größe mounten.
- Das tldraw-Seitenmenü bleibt unverändert aktiv; Seiten werden über die
  öffentliche tldraw-Aktion `editor.deletePage` gelöscht. Der generische
  Client überschreibt diese UI nicht.

## Seiten- und Link-Vertrag

Nur die aktive tldraw-Seite ist für den Snapshot sichtbar. Der bestehende
interne Seitenlink-Vertrag lautet:

```text
#dsh-whiteboard-page=<encodeURIComponent(pageId)>
```

Interne Seitenlinks werden vor tldraws Standard-`window.open` abgefangen und
im selben Tab auf der vorhandenen DSH-Oberfläche navigiert. Selbstverweise auf
die aktuelle Seite werden nicht erzeugt. Ein neuer Tab darf nicht zu einem
kontextlosen oder geschlossenen DSH-Panel führen.

## Fehlerverhalten

- Jede programmatische Board-Aktion ist einzeln abgefangen; ein fehlerhafter
  Befehl darf den Poll-Loop nicht beenden.
- Bei tldraw-Schemafehlern: Fehler protokollieren, Board nicht zurücksetzen,
  Seite neu laden und Snapshot-Persistenz erhalten.
- `live=false` bedeutet „kein aktueller Browser-Client lauscht“, nicht „Board
  ist leer“.
- Kurzzeitige Netzwerkabbrüche beim DSH-API-Request werden einmal begrenzt
  wiederholt. Der kompakte Live-Snapshot und der dauerhafte Vollsnapshot sind
  getrennt; ein Ausfall des einen beendet den anderen Sync nicht.

## Nicht-Ziele

Kein Domain-Persistenzmodell, keine pädagogische Entscheidung, kein
automatischer Turn durch eine Board-Änderung und kein WebSocket-Live-Sync sind
Teil dieses generischen Plugins.
