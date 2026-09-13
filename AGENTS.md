# dsh-tldraw Arbeitsregeln

Dieses Repository enthält das generische DSH-Whiteboard-Plugin. Es ist die
technische Basis für tldraw auf DSH; pädagogische Semantik und PTS-Domainlogik
gehören in `F:\code\pedagogical-thinking-space`.

## Verbindliche Grenzen

- Host und Client bleiben getrennt: `plugin/dsh-whiteboard/lib/index.js` ist
  ESM im DSH-Prozess, `lib/client.js` ist ein Classic Script im Browser.
- Der Client verwendet genau eine tldraw-Instanz pro Session. Den globalen
  Host-DOM-Knoten nur per `appendChild` umhängen, niemals per React-Unmount.
- Session-ID und Workspace müssen aus dem Host-/Session-Kontext stammen. Keine
  globale oder geratene Fallback-ID verwenden, wenn dadurch ein fremdes Board
  sichtbar werden könnte.
- `whiteboard_state`, Primitive und `whiteboard_render_plan` bleiben interne
  Seams. Eine Domänenschicht darf nur ihre eigene semantische Fassade zeigen.
- Keine Domain-Dateien, `decisions.yml`, Lernmomente oder bidirektionale
  PTS-Synchronisierung in diesem Repository einführen.
- Versionskonflikte und fehlende Live-Clients fail-closed behandeln. Kein
  stilles Überschreiben eines fremden Board-Stands.

Die ausführliche technische Spezifikation steht in
[`docs/WHITEBOARD-SPEC.md`](docs/WHITEBOARD-SPEC.md). Die Test- und
Abnahmeregeln stehen in [`docs/TESTING.md`](docs/TESTING.md).

## Vor jeder Änderung

1. Installierte tldraw- und DSH-Version feststellen; die Upstream-Referenz in
   `docs/vendor/tldraw/llms-full.txt` ist ergänzend, nicht automatisch die
   installierte API.
2. Bestehende Snapshot-, Queue-, Slot- und Persistence-Verträge lesen.
3. Prüfen, ob die Änderung Host, Client, beide oder nur Dokumentation betrifft.
4. Bei Shapes zuerst das exakte tldraw-Schema prüfen. Nach einem Schema-Crash
   nur neu laden, niemals „Reset data“ auslösen.

## Pflichtprüfungen

Mindestens ausführen:

```powershell
node --check F:\code\dsh-tldraw\plugin\dsh-whiteboard\lib\client.js
node --check F:\code\dsh-tldraw\plugin\dsh-whiteboard\lib\index.js
node --test --test-isolation=none F:\code\pedagogical-thinking-space\tests\pts-whiteboard-renderer.test.mjs
git diff --check
```

Nach jeder statischen Client- oder Host-Änderung ist ein echter DSH-Neustart
erforderlich; ein Browser-Reload allein lädt den Plugin-Code nicht neu.

## Abnahme-Kategorien

Eine Aussage „getestet“ muss die Kategorie nennen:

- **Static:** Syntax, Imports, Specs und Unit-/Contract-Tests.
- **Live boot:** Profil, Host-Tools, Route und Client-Bundle im laufenden DSH.
- **Browser E2E:** echte UI-Aktionen in einem kontrollierten Browser.
- **Menschliche Sichtprüfung:** visuelle Bindung von Pfeilen, Layout und
  Workspace-Auswahl. Sie darf nicht aus Quelltext oder Unit-Tests abgeleitet
  werden.

Für E2E müssen URL, Browserkontext, Session/Workspace, Wartezeiten und
beobachtetes Ergebnis protokolliert werden. Ein isolierter Browser beweist
nicht, dass eine bereits geöffnete Benutzerinstanz denselben Zustand hat.

## Sicherheits- und Datenregeln

- Öffnungsanforderungen sind sessiongebunden; bei mehreren offenen Sessions
  darf eine identitätslose Anfrage nicht irgendein Board öffnen.
- Ressourcenpfade bleiben workspace-begrenzt, MIME- und größenbegrenzt.
- Keine Tokens, Credentials, vollständigen URLs mit Token oder privaten
  Snapshot-Inhalte in Logs, Commits oder Testberichten speichern.
- Testdaten in `WB-Tests` ausdrücklich als Testartefakte kennzeichnen und nach
  der Abnahme nur nach klarer Zielbestimmung entfernen.

