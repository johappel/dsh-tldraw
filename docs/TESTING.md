# Test- und Abnahme-Workflow

## Grundsatz

„Unit-Tests bestanden“ und „im Browser funktioniert“ sind getrennte Aussagen.
Jeder Bericht nennt die ausgeführte Ebene und darf keine stärkere Abnahme
behaupten.

## 1. Static / Contract

```powershell
node --check F:\code\dsh-tldraw\plugin\dsh-whiteboard\lib\client.js
node --check F:\code\dsh-tldraw\plugin\dsh-whiteboard\lib\index.js
node --test --test-isolation=none F:\code\dsh-tldraw\plugin\dsh-whiteboard\test\render-layout.test.mjs
node --test --test-force-exit F:\code\dsh-tldraw\plugin\dsh-whiteboard\test\arrow-schema.test.mjs
node --test --test-isolation=none F:\code\pedagogical-thinking-space\tests\pts-whiteboard-renderer.test.mjs
git diff --check
```

`arrow-schema.test.mjs` lädt das vendorte tldraw-Runtime und validiert
Pfeil-Props gegen das echte Schema (`text` wird als `Unexpected property`
abgelehnt, `richText` und labelfreie Pfeile sind gültig). Das Runtime hält den
Event-Loop offen, deshalb ist `--test-force-exit` erforderlich; die Datei nicht
über einen ganzen Ordnerlauf ohne dieses Flag einsammeln.

Der Renderer-Test muss mindestens Semantik-/Rollenvalidierung, fail-closed
Referenzen, interne Tool-Grenze und den Handshake „closed → request open →
live → render“ abdecken.

## 2. Live-Boot

Die aktive Instanz wird vor einem Client-Test neu gestartet. Prüfen:

```powershell
$env:DSH_HOME = 'F:\dsh-instances\pts\.dsh'
dsh --profile pts --dump-config
```

Der Dump muss den `dsh-whiteboard`-Host, den PTS-Renderer und den aktiven
`pts-companion`-Default zeigen. Der Host muss beim Boot seine Route und die
internen Whiteboard-Tools registrieren. Eine Client-Änderung gilt erst nach
Neustart und anschließendem Hard-Reload als geladen.

## 3. Browser-E2E-Szenarien

Die Szenarien laufen mit einem kontrollierten Browser gegen eine frisch
gestartete lokale URL. Tokens gehören nur in den Prozess bzw. die URL des
Tests, niemals in Logs oder Dokumentation.

| ID | Ablauf | Erwartung |
|---|---|---|
| A | DSH öffnen, Board-Opener suchen | Opener sichtbar; bei geschlossenem Tab kein tldraw-Mount in 0×0 |
| B | Opener anklicken | rechte Sidebar öffnet, tldraw lädt, `whiteboard_state` wird live |
| C | Board offen, Hard-Reload | Sidebar öffnet wieder; kein `no session surface`-Fehler; derselbe Workspace-/Session-Kontext |
| D | Board geschlossen, semantischen Companion-Auftrag senden | Host fordert Öffnung an; Sidebar öffnet; exakter neue Zettel ist sichtbar; kein Erfolg bei Timeout |
| E | Seitenlink „Zur Übersicht“ anklicken | gleicher Tab, vorhandene DSH-Oberfläche, aktive Seite wechselt; kein neuer Tab |
| F | Zettel verschieben, gebundenen Pfeil beobachten | Pfeil folgt dem Zettel; diese Abnahme braucht zusätzlich menschliche Sichtprüfung |

Für A–E erfassen: `boardView` vor/nach Aktion, sichtbare Schlüsseltexte,
localStorage-Ansichtspräferenz, Console-Fehler, Session-ID und Workspace.
Für D muss zusätzlich die Agentenantwort und der nachfolgende Snapshot geprüft
werden; eine reine Chat-Antwort reicht nicht.

## 4. Regressionsfälle

- Geschlossenes Board darf nicht nur `whiteboard-not-live` melden, ohne vorher
  die Öffnung angefordert zu haben.
- Früher Reload darf einen einzelnen `openTab`-Fehler nicht dauerhaft machen;
  der Opener muss bis zum Session-Surface retryen.
- Mehrere Sessions dürfen keine identitätslose Öffnungsanforderung auf ein
  fremdes Board auflösen.
- Ein leerer, aber live geöffneter Zustand ist gültig und darf nicht als
  „Client fehlt“ behandelt werden.
- Falsche tldraw-Props dürfen weder den Poll-Loop noch die gesamte DSH-Seite
  unkontrolliert beenden.
- Wiederholte Zustellung desselben Renderauftrags darf keine zweiten
  agenteneigenen `renderer:*`-Shapes erzeugen; ein Reload bereinigt vorhandene
  Render-Key-Duplikate deterministisch.
- Im Seitenmenü eine zweite Seite anlegen, ihr Untermenü öffnen und „Löschen“
  wählen: Die Seite verschwindet unmittelbar, der verbleibende Stand wird
  nach dem nächsten Store-Listener-Sync wieder geladen.
- Eine **menschliche** Aktion an einem Objekt, das der Renderer angelegt hat
  (Zettel verschieben, Text ändern, Reparenting), protokolliert den Vorgang,
  darf das Whiteboard-Log aber **nicht** automatisch einblenden. Nur eine
  tatsächlich ausgeführte Agentenaktion öffnet das Auto-Fenster; ein replayed
  Ack derselben `commandId` zählt nicht als Aktion.
- Gestaltungsleiste: In einer Sidebar über 640 px Breite lässt der Kopfzeilen-
  Knopf `🎨` die tldraw-Leiste oben rechts verschwinden und bringt **genau
  dieselbe** Leiste zurück — ohne Neuladen, ohne zweiten Editor und ohne
  Board-Reset. In einer Sidebar bis 640 px Breite rendert tldraw keine
  angedockte Leiste; dort muss der Kompakt-Knopf der Werkzeugleiste die
  Gestaltung weiterhin öffnen, auch während der Schalter „aus“ zeigt. Eine
  Agentenaktion und der Log-Knopf dürfen die Gestaltungsleiste weder ein- noch
  ausblenden.
- Kopfzeilen-Knöpfe: `🎨` und `📋` tragen keinen sichtbaren Text mehr. Beide
  müssen als Tooltip den vollständigen Satz zeigen („Gestaltung ausblenden — …“,
  „Log einblenden — …“) und im aktiven Zustand sichtbar leuchten. In einer
  schmalen Sidebar darf die Kopfzeile durch die beiden Knöpfe nicht umbrechen.

### Netzwerk-Leerlauf

Bei drei Sekunden Leerlauf darf es keine wiederholten leeren Open- oder
Command-Request/Response-Zyklen geben. Dauerhafte, sessiongebundene
Event-Verbindungen sind zulässig; ein Renderauftrag darf nur an seine eigene
Session ausgeliefert werden.

## Abnahmeprotokoll

```text
Datum:
DSH-Version / tldraw-Version:
Browser + Kontext:
Session / Workspace:
Static:
Live boot:
Browser E2E A–F:
Console-/Runtime-Fehler:
Testartefakte:
Offene Grenzen:
```
