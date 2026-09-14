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
  └─ versionierter Snapshot-Store im Workspace (`.dsh-whiteboard/snapshot.json`)
        ▲ HTTP-API
        │
Browser: shell.overlay opener + rechte Sidebar
  └─ eine tldraw-Instanz, persistenceKey dsh-whiteboard-board-<boardId>
```

Die browserlokale IndexedDB ist ein Cache. Der Host-Store liegt direkt im
Workspace unter `.dsh-whiteboard/snapshot.json` und ist die gemeinsame
Persistenzquelle für Neustart und Browserwechsel; das ist kein Echtzeit-
Mehrbrowser-Sync. Version/ETag-Konflikte werden geschützt, nicht automatisch
zusammengeführt. Der `boardId` wird ausschließlich aus dem aufgelösten
Workspace abgeleitet. Mehrere Sessions desselben Workspace verwenden deshalb
dieselbe lokale Board-Datei; die Session-ID bleibt nur die Identität des Live-
Eventkanals und des konkreten Agentenauftrags. Alte zentrale Snapshots unter
`$DSH_HOME/whiteboard-snapshots` werden beim ersten Zugriff kopiert und nicht
gelöscht.

Eine fehlende oder unbekannte Session darf nicht auf `process.cwd()` oder einen
anderen geratenen Workspace zurückfallen. Board-Auflösung und dauerhafte
Speicherung bleiben in diesem Fall fail-closed.

## Öffnen und Reload

Der Opener muss auch bei geschlossener Sidebar im `shell.overlay` leben.

1. Eine semantische Agentenaktion liest `whiteboard_state`.
2. Bei `live=false` ruft der Host intern `whiteboard_request_open` mit der
   Session-ID auf.
3. Der Browser-Opener nimmt nur das passende sessiongebundene Signal an und
   ruft `sidebarRight.openTab('whiteboard')` auf. Der Opener lebt in der
   root-scoped `shell.overlay`-Fläche und liest die aktive Session deshalb über
   `useSessions(state.current)`; der Sidebar-Body selbst erhält weiterhin
   `sessionId`/`useSession` direkt. Ein Rückgabewert von `openTabIn` gilt beim
   Reload noch nicht als Erfolg: Der Opener wiederholt den Versuch, bis der
   sessiongebundene Board-Body die Ziel-Session übernommen hat, und bestätigt
   die Öffnung erst dann gegenüber dem Host.
4. Der Renderer wartet begrenzt auf den ersten Live-Snapshot und reiht erst
   danach den RenderPlan ein.
5. Ein explizit geöffnetes Board speichert seine Ansicht pro Browser-Origin.
   Beim Reload wird das Öffnen wiederholt, falls der Session-Surface beim
   ersten Render noch nicht gemountet ist. Die workspacegebundene Board-ID
   wird während der Session-Rehydration begrenzt erneut aufgelöst; ein
   endgültiger Identitätsfehler bleibt fail-closed.
   Überlappende asynchrone Mount-Versuche werden über eine Laufnummer
   verworfen; nur der noch aktuelle Session- und Persistence-Key darf den
   einen globalen tldraw-Host mounten.

Ein fehlender oder nicht erreichbarer Browser bleibt nach dem Timeout ein
ehrlicher `blocked`-Zustand; der Agent darf keinen Erfolg behaupten.

## Shape-Schema (tldraw 5.4.2)

- Note-Text: `props.richText` als TipTap-Dokument, nicht `props.text`.
- Freitext: `type: 'text'` mit `props.richText`, `font: 'sans'`, einer
  allowlisteten Größe (`s`, `m`, `l`, `xl`) und `autoSize: true`. Der
  generische RenderPlan nimmt dafür nur neue, nicht-leere Text-Elemente an;
  vorhandene Shapes werden nicht in Freitext umgedeutet.
- Pfeil-Label: `props.richText` als TipTap-Dokument (über `toRichText`), nicht
  `props.text`; ein Pfeil ohne Label lässt die Label-Property ganz weg.
  Geometrie `props.start` und `props.end` als `{x, y}`.
- Frames: `{w, h, name}`; Frame-Hintergründe mit `sendToBack` hinter den
  Inhalt legen.
- Der generische RenderPlan legt seine eigenen Karten mit `font: 'sans'` an,
  misst die Höhe jeder Kartenzeile und erweitert den Arbeitsframe bei Bedarf.
  Nur diese neuen `renderer:*`-Shapes werden danach als Frame-Kinder in lokale
  Koordinaten überführt; menschliche Shapes bleiben stets außerhalb dieser
  Löschkaskade.
- Ein Arbeitsraum ist ein benannter Heading-Frame mit `meta.workspaceKey`
  (normalisierter Titel). Ein Render ersetzt nur den Frame mit gleichem Schlüssel
  auf der Zielseite; ein neuer Titel legt einen zweiten Frame darunter an, statt
  vorhandene Frames zu löschen. Vor dem Löschen eines Frames werden alle nicht
  renderer-eigenen Kinder (menschliche Zettel, Pfeile, fremde Arbeitsräume) auf
  die Seite umgehängt, damit die tldraw-Löschkaskade sie nicht mitreißt.
- Die Reload-Bereinigung (`dedupeRendererSnapshot`) gruppiert einen
  Arbeitsrahmen nach **demselben** Identitätsbegriff wie der Render-Pfad: Seite
  plus `workspaceKey` beziehungsweise normalisierter Titel. Ein `renderKey`
  allein ist dokumentweit nicht eindeutig — er würde alle Arbeitsräume aller
  Seiten zu einer Gruppe verschmelzen und nur den neuesten stehen lassen.
  Beide Schreibweisen des Heading-Schlüssels (`renderer:` und das historische
  `pts-whiteboard:`) bezeichnen dieselbe Art Ort und werden auf **eine** Gruppe
  abgebildet; ein Board, das einen alten und einen neuen Rahmen desselben
  Arbeitsraums trägt, reduziert sie daher auf einen statt zwei zu behalten.
- **Element-Keys sind pro Render, nicht pro Board.** Der Renderer vergibt seine
  Karten-Keys aus dem RenderPlan (`renderer:c1`, `renderer:p1`, …). Zwei
  Arbeitsräume desselben Boards tragen deshalb legitim denselben Element-Key.
  Die Reload-Bereinigung gruppiert eine Karte zusätzlich nach ihrem
  Arbeitsraum: nur eine wiederholte Lieferung **innerhalb desselben**
  Arbeitsraums gilt als Duplikat. Karten außerhalb eines Arbeitsraums behalten
  die dokumentweite Regel. Ohne diese Bindung würde die ältere Karte als
  Duplikat der neueren gelten und ihr Arbeitsraum leer zurückbleiben.
- Der generische Template-Katalog umfasst `comparison`, `pro_con`,
  `cause_effect`, `sequence`, `cluster`, `matrix` und `timeline`.
  Vergleichsformen haben feste Freitext-Überschriften und horizontale/vertikale
  Trennlinien; Sequenz und Zeitstrahl lesen links nach rechts. Nicht bekannte
  Template-Namen enden vor der Mutation mit einem Fehler.
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

## Oberflächen-Schalter (menschlich)

Die Gestaltungsleiste oben rechts (Farbe, Strichstärke, Deckkraft, Schrift,
Ausrichtung, Rahmen) gehört dem Menschen und nur ihm.

- `components.StylePanel` wird von tldraw genau einmal je Editor gelesen und
  über den UI-Komponenten-Kontext gemischt. Der Client baut das
  Komponenten-Objekt deshalb genau einmal pro geladener Runtime und schaltet
  die Sichtbarkeit **innerhalb** des Slots um — derselbe Editor, derselbe
  `persistenceKey`, kein Store-Schreibvorgang und kein Neumount.
- Der Schalter ist ausschließlich an den Knopf `🎨` in der Kopfzeile gebunden.
  Er folgt weder einer Agentenaktion noch dem Whiteboard-Log; die beiden Knöpfe
  bleiben unabhängig. `🎨` und `📋` sind die beiden einzigen Knöpfe der
  Kopfzeile ohne sichtbaren Text: Der sichtbare Inhalt ist das Icon, die
  Beschriftung liegt vollständig in `aria-label` (Name), `title` (Tooltip samt
  Begründungssatz) und `aria-pressed` (an/aus). Damit bricht die Kopfzeile in
  einer schmalen Sidebar nicht um, ohne dass Screenreader oder Tooltip
  Information verlieren.
- Die Leiste startet **ausgeblendet** (tldraws eigener Standard wäre sichtbar).
  Die Sidebar bleibt dadurch ruhig, bis der Mensch Gestaltung anfordert; der
  Knopf `🎨` bleibt in diesem Zustand unmarkiert, `aria-label` lautet
  „Gestaltung einblenden“.
- In einer Sidebar oberhalb der tldraw-Breakpoint-Schwelle (`TABLET_SM`,
  Breite > 640) rendert tldraw die angedockte Leiste und der Schalter blendet
  sie aus und wieder ein. In einer schmaleren Spalte existiert die angedockte
  Leiste nicht; dort bedient tldraws eigener Kompakt-Knopf in der
  Werkzeugleiste dieselbe Gestaltung. Dieser Slot bleibt deshalb in der
  Kompakt-Platzierung immer durchlässig: Der Schalter darf niemandem den
  letzten Zugang zur Gestaltung nehmen (`MobileStylePanel` liefert `null`,
  sobald der Slot fehlt).
- Eine eingeschaltete, aber leere Leiste ist gültig. `DefaultStylePanel` zeigt
  nichts an, solange kein Zeichenwerkzeug aktiv ist und keine Form mit
  Stiloptionen ausgewählt wurde.

## Fehlerverhalten

- Jede programmatische Board-Aktion ist einzeln abgefangen; ein fehlerhafter
  Befehl darf den Poll-Loop nicht beenden.
- Bei tldraw-Schemafehlern: Fehler protokollieren, Board nicht zurücksetzen,
  Seite neu laden und Snapshot-Persistenz erhalten.
- `connected=true` bedeutet, dass der sessiongebundene Command-EventStream
  aktuell offen ist. `live=true` wird gesetzt, wenn dieser Schreibkanal und ein
  kompakter Snapshot vorliegen. Ein unverändertes, aber geöffnetes Board bleibt
  damit auch nach mehr als 15 Sekunden schreibbar; das Alter des letzten
  Snapshots trennt den Kanal nicht. Ein verbundenes Board ohne Snapshot bleibt
  für den Companion nicht lesbar.
- Nach einem Host-Neustart sendet ein erneut verbundener Browser genau einen
  Bootstrap-Snapshot, auch wenn auf dem Canvas noch keine neue Mutation
  stattgefunden hat.
- Kurzzeitige Netzwerkabbrüche und die kurze Reihenfolgeverschiebung zwischen
  DSH-Route und Session-Registry werden bei der aktiven Board-Auflösung
  begrenzt wiederholt. Der kompakte Live-Snapshot und der dauerhafte
  Vollsnapshot sind getrennt; ein Ausfall des einen beendet den anderen Sync
  nicht.
- Bei der Hydration werden ausschließlich agenteneigene `renderer:*`-Shapes mit
  demselben Render-Key dedupliziert; menschliche Shapes bleiben unverändert.

### Render-Command-Handshake

Ein Renderauftrag erhält eine sessiongebundene `commandId`. `accepted: true`
heißt nur: Der Host hat den Auftrag angenommen bzw. an den passenden
Browser-Eventkanal übergeben. Das ist kein sichtbarer Erfolg. Der Client sendet
nach der Ausführung im nächsten `wb-snapshot` ein `commandResults`-Element mit
derselben ID und `ok: true` oder `ok: false`. Erst die positive Kombination aus
ID, Ergebnis und Folge-Snapshot gilt als bestätigt (`verified`).

Der Client puffert Events, die während des asynchronen tldraw-Ladens eintreffen,
und ignoriert eine bereits erfolgreich ausgeführte ID bei einer Nachlieferung.
Bei fehlendem oder negativem Ack darf der semantische Aufrufer den gleichen
Auftrag mit derselben ID höchstens einmal wiederholen. Danach bleibt der
Auftrag ehrlich `pending` bzw. `failed`; `queued` darf nicht als Erfolg
ausgegeben werden. Die Bestätigungen sind flüchtig und werden nicht in den
dauerhaften tldraw-Snapshot persistiert.

## Nicht-Ziele

Kein Domain-Persistenzmodell, keine pädagogische Entscheidung, kein
automatischer Turn durch eine Board-Änderung und kein WebSocket-Live-Sync sind
Teil dieses generischen Plugins.
