---
name: dsh-instancing
description: Eine eigene, isolierte DSH-Instanz aufsetzen — eigenes DSH_HOME, eigener Port, eigener Workspace-Root, eigenes Agent-Preset, lokale Plugins. Verifiziertes Rezept samt der Fallstricke, die sonst zu leeren Sidebars, wirkungslosen Config-Zeilen oder „unknown option"-Abbrüchen führen. Nutzen, wenn neben der laufenden eine zweite oder dritte dsh-Instanz entstehen soll.
---

# DSH-Instanz aufsetzen (isoliert)

Verifiziert an der Instanz `pts` (dsh 0.1.5-rc.2, Windows): Profil `pts`, Port 3030, Home `F:\dsh-instances\pts\.dsh`, Workspace `F:\dsh-workspaces\pts`, Preset `pts`, Plugin `dsh-whiteboard`.

**Autorität sind die Referenz-Dokumente — niemals eine bestehende Installation als Vorlage.** Genau daraus entstand der Holzweg „Ordner werden nicht angezeigt":

| Frage | Belegstelle |
|---|---|
| Profile, Launcher-Flags, Default-Workspace-Root | `apps/cli/README.md` |
| Jeder Config-Key (generiert, maßgeblich) | `docs/config-catalog.md` |
| Port/Host der Instanz | `docs/subsystems/web-server.md` |
| Workspace-Registry, Bootstrap, GUI-Fluss | `docs/subsystems/workspace.md` |
| Presets: Roster, Roots, Autorierung | `packages/preset/agent-presets/README.md` |

## 1. Isolationsgrad wählen (zuerst entscheiden)

| Ziel | Mittel | Konsequenz |
|---|---|---|
| Nur andere Oberfläche/Port | neues Profil im **geteilten** `~/.dsh` | Sessions, Storages (Workspace-Registry!), Settings geteilt → die Instanz zeigt fremde Projektordner |
| Eigene Projektordner, eigene Historie | **eigenes `DSH_HOME`** | Registry/Sessions/Settings/Credentials eigene; alte Sessions sind dort nicht sichtbar |
| Nur Credentials weiter teilen | eigenes Home + `.credentials.yaml` hineinkopieren | Schlüsselrotation in beiden Homes nachziehen |

Die Workspace-Liste der Sidebar ist eine **Laufzeit-Registry**, kein Config-Objekt. Wer „nur die eigenen Ordner" will, braucht ein eigenes Home (oder ein filterndes Sidebar-Plugin — nicht dokumentiert). Config-Zeilen wie `sandbox-policy.workspaceRoot` erzeugen **keine** Sidebar-Gruppe.

## 2. Home und Profil anlegen

```powershell
$env:DSH_HOME = 'F:\dsh-instances\pts\.dsh'          # eigenes Home
New-Item -ItemType Directory -Force $env:DSH_HOME | Out-Null
dsh --profile pts --from-default-profile web --dump-config
```

- `--from-default-profile <template>` kopiert ein ausgeliefertes Template (`web`, `headless`, `sdk`, `sdk-minimal`, `acp`) auf einen **freien, nicht ausgelieferten** Namen; das Zielverzeichnis darf noch nicht existieren.
- `--dump-config` legt das Profil an und beendet sich, **ohne** Server. Ohne die Option bootet der Befehl sofort.
- Die Bundle-Auflösung in einem frischen Home ist automatisch: dsh spiegelt die Abhängigkeits-Closure der Installation nach `$DSH_HOME\profiles\node_modules`. **Kein `pnpm install` nötig.**
- Es entstehen `profiles\pts\{package.json, cordis.yml, cordis.patch.yml, pnpm-workspace.yaml}`.

## 3. Patch-Schicht schreiben (`profiles\pts\cordis.patch.yml`)

```yaml
# Port: Fallback dieses Profils; das App-Argument --port gewinnt weiterhin.
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3030

# Fallback-Root NUR für Aufrufe ohne Session-cwd. Der echte Session-cwd ist die
# aufrufende Directory bzw. der im UI gewählte Workspace.
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: 'F:/dsh-workspaces/pts'

# Default-Preset dieser Instanz. includeUserRoot bleibt auf Schema-Default true,
# also wird <DSH_HOME>/.agent-presets gescannt.
- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: pts

- insert:
    - id: dsh-whiteboard
      name: dsh-whiteboard
      inject: [webServer]
```

Regeln dazu:

- **Ein Patch ersetzt die ganze `config` der Zielzeile.** Nur die Keys hinschreiben, die diese Zeile besitzt; Schema-Defaults füllen den Rest (deshalb reicht `default: pts` beim Roster).
- Layer-Reihenfolge: Bundles → Profil-Patch → Home-Patch → `--patch`. Der Profil-Patch gewinnt also gegen `web-app`.
- Eigene Profile haben `patchReload: live`: Patch-Änderungen greifen ohne Neustart. **Client-Bundles brauchen trotzdem einen Browser-Reload.**
- `sandbox-policy.mode` hat den Fail-Safe-Default `read-only` — ohne explizites `workspace-write` ist die Instanz schreibgeschützt.

## 4. Lokales Plugin einbinden

Dokumentierter Weg (pnpm im Profil): `dsh plugin --profile pts add <paket>`.
Offline-Äquivalent für ein Repo-Paket (verifiziert):

```powershell
$P = "$env:DSH_HOME\profiles\pts"
New-Item -ItemType Directory -Force "$P\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$P\node_modules\dsh-whiteboard" -Target 'F:\code\dsh-tldraw\plugin\dsh-whiteboard'
```

Plus die `insert`-Zeile aus §3. Braucht das Plugin eine Host-Route, ist `inject: [webServer]` Pflicht. Deklariert das Paket `dsh.client` in `package.json`, landet die Client-Hälfte automatisch im Browser-Roster (Boot-Manifest, sichtbar in der `index.html`).

## 5. Eigenes Agent-Preset

Ein Preset ist **ein Verzeichnis mit einer `agent.cordis.yml`**; das Roster findet es über die Roots: ausgelieferte `presets/`, konfigurierte `roots`, und der User-Root `<DSH_HOME>/.agent-presets` (Default `includeUserRoot: true`).

```powershell
$H = $env:DSH_HOME
New-Item -ItemType Directory -Force "$H\.agent-presets\pts" | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh-agent-presets\presets\standard\agent.cordis.yml" `
          "$H\.agent-presets\pts\agent.cordis.yml"
# preset.yml mit name + description daneben schreiben
```

- Id-Regel: `[a-z0-9][a-z0-9-]*` (wird zum Verzeichnisnamen). `default` ist **required** — fehlt das Preset beim Mount, schlägt es laut fehl.
- Die Roster-Autorierung ist **copy-only** (Kopie landet im ersten `user`-Root, Löschen nur dort). Eine Handkopie eines ausgelieferten Presets ist byte-identisch und damit genau so gesund wie das Original.
- Default setzen: `agent-presets.default` im Patch **und** im Settings-Dokument (`agent-presets: { default: <id>, modeSelectionEnabled: true }`). Bei aktivierter Auswahl überschreibt der User-Default den Deployment-Default.
- Kompositionen schreibt man nicht „frei": vor Änderungen die Skill `editing-cordis-compositions` laden.

## 6. Settings und Credentials seeden

Ein isoliertes Home startet mit leerem Settings-Dokument (keine Modellwahl). Bewährt: Settings der laufenden Instanz kopieren und den Roster-Default umschreiben.

```powershell
$H = $env:DSH_HOME
(Get-Content "$env:USERPROFILE\.dsh\settings.yaml" -Raw) -replace '(?m)^agent-presets:\r?\n  default: \S+', "agent-presets:`r`n  default: pts`r`n  modeSelectionEnabled: true" |
  Set-Content "$H\settings.yaml" -Encoding UTF8
Copy-Item "$env:USERPROFILE\.dsh\.credentials.yaml" "$H\.credentials.yaml" -Force
```

Will man die Keys **nicht** teilen: `credentials`-Zeile patchen (`path: '<home>/.credentials.yaml'`) und dort neu eintragen.

## 7. Verifikation (immer beide Stufen)

**a) Komposition prüfen** — belegt, dass die Patch-Zeilen greifen:

```powershell
$env:DSH_HOME='F:\dsh-instances\pts\.dsh'
dsh --profile pts --dump-config | Select-String 'id: webserver','dsh-whiteboard','id: agent-presets','id: sandbox-policy' -Context 0,5
```

**b) Smoke-Test des Servers** — belegt Port, Auth-Fence und Client-Roster:

```powershell
# als Hintergrundjob, --no-open verhindert ein Browserfenster
$env:DSH_HOME='F:\dsh-instances\pts\.dsh'; Set-Location 'F:\dsh-workspaces\pts'; dsh --profile pts --no-open
# Logzeile: "dsh web: http://127.0.0.1:3030/?token=<TOKEN>"
Invoke-WebRequest 'http://127.0.0.1:3030/'                      # 401 — Auth-Fence aktiv
Invoke-WebRequest "http://127.0.0.1:3030/?token=<TOKEN>"        # 200 — Manifest enthält die Plugin-Id
Invoke-WebRequest 'http://127.0.0.1:3030/plugins/??dsh-whiteboard/client.js&rev=<rev>'   # 200 — Bundle wird ausgeliefert
```

Danach den Job beenden, **sonst blockiert Port 3030 den echten Start** (ein Listen-Fehler lässt den Boot scheitern).

## 8. Startskript

```powershell
# start-pts.ps1
$env:DSH_HOME = 'F:\dsh-instances\pts\.dsh'
Set-Location 'F:\dsh-workspaces\pts'   # aufrufende Directory = Default-Workspace-Root
dsh --profile pts --port 3030
```

## 9. Fallstricke (jeder kostete real Zeit)

1. **Launcher-Flags vor App-Argumenten.** Das erste unbekannte Token startet die App-Argumente. `dsh --profile pts --port 3030 --dump-config` → `error: unknown option '--dump-config'`, weil `--port` die App startet. Richtig: `dsh --profile pts --dump-config`.
2. **`sandbox-policy.workspaceRoot` ist nicht der Session-cwd.** Doku: *„Fallback root for agentless calls and sessions without a cwd … Normal agent calls use their session cwd instead."* Ordner-Pins in der Config erzeugen keine Sidebar-Gruppe.
3. **Sidebar-Gruppen sind Registry-Datensätze.** Angelegt zur Laufzeit über `ctx.remote.workspace.create` (UI-Picker) über ein **existierendes** Verzeichnis; der Bootstrap läuft **einmalig** und gruppiert nur persistierte Session-Header. Neue Sessions landen nur per `attachSession` in einer Gruppe. Also: Ordner anlegen → Instanz starten → Ordner im Picker registrieren. Bei geteiltem Home sieht man zusätzlich alle fremden Gruppen.
4. **`default` fehlt = lauter Fehlschlag.** Ein Preset-Id, das nicht im Roster liegt, lässt die Session-Erstellung fehlschlagen („Missing at mount time fails loud").
5. **Bundle-URLs brauchen die Batch-Form.** `/plugins/<id>/client.js` → 404; korrekt ist die URL aus dem Manifest: `/plugins/??<id>/client.js&rev=<rev>`.
6. **Signale statt Raten.** Prüfen: `--dump-config` (Zeilen), Logzeile mit URL+Token, `dsh-process.json`, `$DSH_HOME\storages\workspace.json`. Bei „Plugin tut nichts" zuerst: Ist die Client-Hälfte im Boot-Manifest? Ist die Host-Zeile im Dump?
7. **Nichts außerhalb des Workspace ist schreibbar** ohne Freigabe: `$DSH_HOME`, Junctions, Skills unter `~\.agents` — jeweils eine bewusste Freigabe einplanen.
8. **Port vorher frei halten.** Ein laufender Test blockiert den Start; EADDRINUSE lässt die Initialisierung fehlschlagen statt auszuweichen.
9. **Credentials sind eine Kopie, kein Link.** Rotation in beiden Homes nachziehen, sonst läuft eine Instanz mit altem Schlüssel.
10. **Alte Installationen sind keine Vorlage.** Wirkungslose Zeilen (z. B. ein per Zeilenumbruch zerrissener `cwd`-Wert) sehen in einem bestehenden Profil wie ein Muster aus. Gegen die Referenz prüfen, dann bauen.

## 10. Checkliste

- [ ] Isolationsgrad entschieden (geteiltes Home vs. eigenes `DSH_HOME`)
- [ ] `$DSH_HOME` gesetzt, `dsh --profile <name> --from-default-profile web --dump-config` gelaufen
- [ ] Patch: `webserver.port`, `sandbox-policy.{mode,workspaceRoot}`, `agent-presets.default`, Plugin-`insert`
- [ ] Lokale Plugins als Junction + Insert-Zeile (bei Host-Route `inject: [webServer]`)
- [ ] Preset-Verzeichnis unter `<DSH_HOME>/.agent-presets/<id>/` mit `agent.cordis.yml` + `preset.yml`
- [ ] `settings.yaml` + `.credentials.yaml` geseedet
- [ ] `--dump-config` zeigt alle Zeilen
- [ ] Smoke-Test: 401 ohne Token, 200 mit Token, Manifest enthält die Plugin-Id, Bundle-URL 200, Job beendet
- [ ] Startskript mit `DSH_HOME` + `Set-Location <root>` + `--port`
- [ ] Erster Workspace im UI-Picker registriert (sonst keine Sidebar-Gruppe)
