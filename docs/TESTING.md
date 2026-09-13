# Test- und Abnahme-Workflow

## Grundsatz

„Unit-Tests bestanden“ und „im Browser funktioniert“ sind getrennte Aussagen.
Jeder Bericht nennt die ausgeführte Ebene und darf keine stärkere Abnahme
behaupten.

## 1. Static / Contract

```powershell
node --check F:\code\dsh-tldraw\plugin\dsh-whiteboard\lib\client.js
node --check F:\code\dsh-tldraw\plugin\dsh-whiteboard\lib\index.js
node --test --test-isolation=none F:\code\pedagogical-thinking-space\tests\pts-whiteboard-renderer.test.mjs
git diff --check
```

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
