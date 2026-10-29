# ShareToFriends 2.0

Bildschirm und App-Audio mit Freunden teilen – bedient wie **Discord** (Stream-Oberfläche), verbunden wie **TeamViewer** (9-stellige ID + Passwort).
Zu Hause wird **kein einziger Router-Port geöffnet**. Ein kleiner VPS vermittelt nur den Verbindungsaufbau, danach läuft der Stream **direkt von PC zu PC** (WebRTC, verschlüsselt).

```
 Streamer-PC ──┐                      ┌── Zuschauer-PC
   (kein Port) │  wss://stf.deine.de  │   (kein Port)
               └──►  VPS: Signaling ◄─┘     nur Verbindungsaufbau
               ╲                      ╱
                ╲══ direkte P2P-Verbindung (DTLS-SRTP) ══╱      Video, Audio, Steuerung
                       (nur wenn nötig: TURN-Relay auf dem VPS, weiterhin Ende-zu-Ende verschlüsselt)
```

## Inhalt

- `app/` – Electron-Desktop-App (Windows)
- `server/` – Signaling-Server, TURN (coturn) und Caddy (TLS) für den VPS
- `LICENSE` – MIT

## 1. Server auf dem VPS einrichten (einmalig, ca. 10 Minuten)

Es reicht ein kleiner VPS (1 vCPU / 1 GB RAM) mit Debian/Ubuntu und Docker.

1. Eine (Sub-)Domain anlegen, z. B. `stf.meinedomain.de`, mit einem **A-Eintrag auf die VPS-IP**.
2. In der Cloud-Firewall des VPS **eingehend** freigeben:

   | Port | Protokoll | Zweck |
   |---|---|---|
   | 80, 443 | TCP | Zertifikat (Let's Encrypt) und Signaling über `wss://` |
   | 3478 | UDP + TCP | STUN / TURN |
   | 49152–49252 | UDP | TURN-Relay (nur als Rückfall) |

3. Auf dem VPS:

   ```bash
   curl -fsSL https://get.docker.com | sh       # falls Docker fehlt
   # Ordner "server/" auf den VPS kopieren (scp/rsync), dann:
   cd server
   chmod +x setup.sh
   ./setup.sh stf.meinedomain.de
   ```

   `setup.sh` erzeugt ein zufälliges TURN-Geheimnis (`.env`), schreibt die coturn-Konfiguration und startet Signaling, coturn und Caddy.
4. Prüfen: `https://stf.meinedomain.de/health` muss `{"ok":true,…}` liefern.

Auf dem Heimnetz/Router ist **nichts** zu tun.

### Was der Server kann (und was nicht)

- Registriert die 9-stellige ID jedes Hosts, leitet Verbindungswünsche und die WebRTC-Aushandlung (SDP/ICE) weiter.
- Verteilt kurzlebige TURN-Zugangsdaten (HMAC, 6 h gültig).
- Begrenzt Missbrauch: 64-KB-Nachrichten, 8 Sitzungen je Host, 24 Verbindungen je IP, 30 Verbindungsversuche pro Minute (gegen ID-Scanning).
- Sieht **keine** Passwörter, **keinen** Video-/Audio-Inhalt. Er kann die Verbindung nicht mitlesen oder umleiten: Der Host prüft das Passwort per Challenge/Response (PBKDF2-SHA256, 600 000 Runden), und die SDP/ICE-Nachrichten werden mit einem daraus abgeleiteten Sitzungsschlüssel authentifiziert. Ein manipulierter Server fällt dabei auf, die Verbindung kommt dann nicht zustande.

## 2. App installieren und verbinden

1. `ShareToFriends-Setup-2.0.0.exe` installieren (oder aus `app/` selbst bauen, siehe unten).
2. **Einstellungen → Server-Adresse**: `wss://stf.meinedomain.de/ws` eintragen. Alle Freunde tragen dieselbe Adresse ein.
3. **Streamer:** „Bildschirm teilen“ → Monitor oder Fenster wählen. Die App zeigt deine **ID** und dein **Passwort**; beides dem Freund geben.
4. **Zuschauer:** ID und Passwort eintragen → „Verbinden“.

**Passwort und ID bleiben gespeichert**, auch nach einem Neustart der App. Das Passwort ändert sich nur, wenn du es willst:
- **↻** erzeugt ein neues zufälliges Passwort,
- **✎** lässt dich ein **eigenes, dauerhaftes Passwort** festlegen (10–64 Zeichen), das du deinen Freunden gibst.

Wer sich verbindet, bekommt es unter **„Zuletzt verbunden“** angezeigt: Die App merkt sich Name, ID und Passwort (verschlüsselt mit deinem Windows-Konto, abschaltbar mit „Passwort merken“), und ein Klick genügt für die nächste Verbindung. Ändert der Streamer sein Passwort, fragt die App nach dem neuen. Falsche Passwörter werden abgewiesen; nach 5 Fehlversuchen innerhalb von 10 Minuten sind neue Anmeldungen 10 Minuten gesperrt (das Passwort bleibt dabei unverändert).

## Funktionen

**Stream (Discord-Stil)**
- Fenster **oder** Monitor teilen; Wechsel während des Streams per Klick ohne Neuverbindung (gemessen ≈ 0,3 s).
- Schwebende Stream-Leiste unten beim Zuschauer: Lautstärke, Zoom, Qualitätsdeckel, Mauszeiger/Zeichnen/Bilder, **Vollbild** (Taste **F** oder **F11**, Doppelklick aufs Bild; **Esc** beendet).
- Vollautomatische Qualität: keine Bitraten- oder Codec-Regler. Die App nutzt die Überlastregelung von WebRTC und zusätzlich einen **Ping-Schutz**: Steigt die Latenz der Leitung des Hosts (Bufferbloat, z. B. weil ein Spiel Bandbreite braucht), drosselt der Stream selbst und geht danach von allein wieder auf die höchste Stufe (bis 1080p60). Der Zuschauer kann nur eine Obergrenze wählen („Auto“, 720p60, 540p30 …). Der **Streamer** wählt in seiner Leiste die Qualität: *Auto* (bis 1080p60, optional mit Obergrenze) oder eine **feste Stufe** (1080p60, 720p60, 720p30) – fest hält die Stufe immer, dann aber ohne Ping-Schutz.
- H.264 bevorzugt (Hardware-Encoder, falls vorhanden), VP8 als Rückfall; Opus-Stereo 128 kbit/s.

**Audio**
- Kein Mikrofon, keine Kamera. Es wird nur Anwendungs-/Systemton übertragen.
- Mischpult mit Pegelanzeige je App, Modus **Alles / nur ausgewählte (Whitelist) / alle außer ausgewählten (Blacklist)** per Häkchen. Pro-App-Erfassung über Windows-Prozess-Loopback.
- Zuschauer regelt seine Lautstärke getrennt (wirkt nur bei ihm).

**Fernsteuerung (optional, nur mit Bestätigung)**
- Zuschauer klickt „Steuerung anfragen“ → beim Host erscheint immer ein Dialog: *„Zugriff für [Name] erlauben? [Ja] [Nein]“*.
- Dauerhafte Leiste „Remote-Zugriff aktiv“ mit „Sofort beenden“; **F12** am Host-PC ist der Notaus (global per Low-Level-Tastaturhook erkannt, solange jemand fernsteuert).
- Maus, Tastatur inkl. Windows-Taste/Alt+Tab/Strg+C/V, **Zwischenablage in beide Richtungen (Text und Bilder)**.
- **Mauszeiger:** Dein Freund sieht deinen Zeiger als ganz normalen weißen Windows-Pfeil in Standardgröße (mit kleinem Namensschild) und kann so genau verfolgen, was du tust. Es gibt dafür keine Einstellungen. Taste **M**.
- **Zeichnen** mit **Bleistift** (dünn), **Filzstift** (kräftig) oder **Marker** (breit, durchscheinend); **beliebige Farbe** (10 Vorgaben plus Farbwähler) und **Dicke** per Regler (Farbe und Dicke gelten für beide Modi). Zwei Modi: *verblasst* (Taste **P**) und *bleibt* (Taste **O**). **C** löscht deine Zeichnungen. Der Host hat einen Knopf **„Desktop leeren“**.
- **Bilder:** Lege ein Bild (z. B. ein Meme) auf den Bildschirm des Streamers: Knopf in der Leiste, **Strg+V** (Bild aus der Zwischenablage) oder Drag & Drop (Taste **B**). Du kannst es **verschieben**, an den Ecken **skalieren**, am Punkt oben **drehen** (Umschalt = 15°-Schritte) und mit gedrückter **Alt-Taste ziehen, um zuzuschneiden**. Mausrad ändert die Größe, *Zuschnitt zurücksetzen* und *Entfernen* gibt es im Panel. Der Streamer sieht das Bild sofort auf seinem Desktop (es ist auch im Stream). Höchstens 8 Bilder je Zuschauer, jedes wird auf 1600 px verkleinert.

**Sonstiges**
- Automatischer Hintergrund-Updater (Banner erscheint nur, wenn gerade nicht gestreamt/zugesehen wird).
- Zuschauer verbinden sich nach Verbindungsabbruch oder neuem Stream des Hosts automatisch neu.
- Läuft der Signaling-Server kurz nicht, laufen bestehende Streams weiter; die App meldet sich von selbst wieder an.

## Sicherheitsmodell in Kürze

| Bedrohung | Schutz |
|---|---|
| Offene Ports zu Hause | Gibt es nicht; alle Verbindungen sind ausgehend. |
| ID raten / Passwort durchprobieren | 9-stellige ID, zufälliges 10-Zeichen-Passwort (≈ 50 Bit) bzw. dein eigenes (mindestens 10 Zeichen – wähle es lang), Rate-Limit am Server, teure Schlüsselableitung (PBKDF2) und 10 Minuten Sperre nach 5 Fehlversuchen. |
| Mitlesen / Manipulieren durch den VPS | Passwort wird nie gesendet (Challenge/Response, gegenseitig), SDP/ICE sind per HMAC gesichert, Medien laufen DTLS-SRTP. |
| TURN als Sprungbrett ins Netz des VPS | coturn verbietet private/lokale Zielbereiche. |
| Fremder Zugriff auf deinen PC | Fernsteuerung nur nach ausdrücklichem „Ja“, jederzeit F12 oder „Sofort beenden“. |
| Schadcode im Renderer | `contextIsolation`, `sandbox`, strenge CSP, nur wenige IPC-Kanäle mit Absenderprüfung. |
| Manipulierte Updates | Nur `https://`-Update-URL, Updater prüft die SHA-512-Prüfsumme aus `latest.yml` (der Installer ist nicht code-signiert). |

## Grenzen (ehrlich)

- **Windows 10/11** (Prozess-Audio und Fernsteuerung nutzen Windows-APIs). macOS/Linux sind nicht vorgesehen.
- Bei **mehreren Zuschauern** kodiert der Host den Stream **je Zuschauer** (WebRTC ohne SFU). 1–3 Zuschauer sind unproblematisch, mehr kostet CPU/Upload.
- Ob **1080p60** erreicht wird, hängt von Encoder (Hardware-H.264 vs. Software), CPU/GPU und Upload ab. Bei reinem Software-Encoding fällt die App automatisch auf eine Stufe, die die Maschine halten kann.
- Der **TURN-Rückfall** (z. B. bei strengem Firmen-NAT) läuft über die Bandbreite deines VPS.
- Die Fernsteuerung kann keine Fenster mit höheren Rechten (Task-Manager als Admin, UAC-Dialoge) bedienen, solange die App nicht ebenfalls als Administrator läuft.
- Der Installer ist **nicht code-signiert**; Windows SmartScreen zeigt beim ersten Start „Unbekannter Herausgeber“.

## App selbst bauen

```bash
cd app
npm ci
npm test                 # Unit-Tests (Adaptive-Regler, ID/Passwort-Handshake, Zeichen-Stile)
npm start                # Entwicklung   (npm run dev: mit Entwickler-Logs)
npm run dist             # Installer nach app/dist/
```

Der Audio-Helfer `helper/StfAudioCapture.exe` wird mit `npm run build:helper` aus `helper/*.cs` gebaut (benötigt das .NET-Framework-Compilerwerkzeug `csc.exe`, das bei Windows dabei ist) und vom Installer mitgeliefert.

### Updates über GitHub

Die App sucht standardmäßig unter `https://github.com/S7VENZZ/ShareToFriends/releases/latest` nach neuen Versionen und installiert sie im Hintergrund. Das Repository muss dafür **öffentlich** sein.

Eine neue Version veröffentlichst du mit einem Befehl:

```powershell
.elease.ps1 2.0.2
```

Das Skript setzt die Version, führt die Tests aus, committet, setzt das Tag `v2.0.2` und pusht. GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)) baut daraufhin den Installer und legt ihn mit `latest.yml` als Release ab. Wenige Minuten später laden alle installierten Apps das Update im Hintergrund und **starten sich selbst neu**, sobald nichts mehr geteilt oder angesehen wird (während eines Streams wartet die App). Nach dem Build bleiben auf GitHub nur die **neuesten zwei Versionen** erhalten, ältere Releases und ihre Tags werden automatisch gelöscht.

In den **Einstellungen → Updates** siehst du die installierte Version, wann zuletzt geprüft wurde und ob ein Update bereitsteht. Dort schaltest du auch „Automatisch aktualisieren“ an oder aus und kannst jederzeit „Jetzt prüfen“ klicken. Geprüft wird beim Start und danach alle 10 Minuten. Eine Update-Adresse muss man nicht eintragen.

### Server testen

```bash
cd server
npm ci
node test.js             # Signaling-Tests (Authentifizierung, Rate-Limits, Relay)
```

## Lizenz

MIT – siehe `LICENSE`.
