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

Der Server läuft auf einem VPS / Root-Server mit **fester IP** (1 vCPU / 1 GB RAM reichen, Debian/Ubuntu). Er macht drei Dinge: Verbindungen vermitteln (Signaling), als TURN-Rückfall dienen und die **App-Updates ausliefern**. Zu Hause muss nichts laufen und nichts geöffnet sein.

1. **DNS:** Bei deinem DNS-Anbieter (z. B. Cloudflare) den A-Eintrag der Server-Domain (`stf.meinedomain.de`) auf die **IP des VPS** setzen. Bei Cloudflare: Proxy aus (graue Wolke, „Nur DNS“).
2. **Firewall** des VPS (beim Anbieter und/oder `ufw`) **eingehend** freigeben:

   | Port | Protokoll | Zweck |
   |---|---|---|
   | 22 | TCP | SSH (nur für dich) |
   | 80, 443 | TCP | Zertifikat (Let's Encrypt), Signaling über `wss://`, Update-Downloads |
   | 3478 | UDP + TCP | STUN / TURN |
   | 49152–49252 | UDP | TURN-Relay (nur als Rückfall) |

3. **Installieren** (auf dem VPS, per SSH):

   ```bash
   curl -fsSL https://get.docker.com | sh            # falls Docker fehlt
   apt-get install -y unzip                          # falls unzip fehlt
   unzip ShareToFriends-Server.zip -d stf && cd stf/server
   chmod +x setup.sh
   ./setup.sh stf.meinedomain.de
   ```

   `setup.sh` erzeugt ein zufälliges TURN-Geheimnis (`.env`), schreibt die coturn-Konfiguration und startet vier Container: **Signaling**, **coturn**, **Caddy** (TLS + Update-Downloads) und **updates-sync** (holt neue Versionen).
4. **Prüfen:** `https://stf.meinedomain.de/health` muss `{"ok":true,…}` liefern, `https://stf.meinedomain.de/updates/latest.yml` nach wenigen Minuten die aktuelle Version zeigen.

### Server absichern (empfohlen)

- Root-Passwort ändern (`passwd`) und **SSH-Schlüssel** statt Passwort nutzen: `ssh-keygen -t ed25519` auf dem PC, `ssh-copy-id root@<IP>`, danach in `/etc/ssh/sshd_config` `PasswordAuthentication no` setzen und `systemctl restart ssh` (erst prüfen, dass die Anmeldung per Schlüssel klappt!).
- `apt-get install -y ufw fail2ban unattended-upgrades`, dann `ufw allow 22/tcp`, `ufw allow 80,443/tcp`, `ufw allow 3478`, `ufw allow 49152:49252/udp`, `ufw enable`.
- Passwörter oder Token **nie** im Chat oder in Dateien im Repository teilen.

### Was der Server kann (und was nicht)

- Registriert die 9-stellige ID jedes Hosts, leitet Verbindungswünsche und die WebRTC-Aushandlung (SDP/ICE) weiter.
- Verteilt kurzlebige TURN-Zugangsdaten (HMAC, 6 h gültig).
- Begrenzt Missbrauch: 64-KB-Nachrichten, 8 Sitzungen je Host, 24 Verbindungen je IP, 30 Verbindungsversuche pro Minute (gegen ID-Scanning).
- Sieht **keine** Passwörter, **keinen** Video-/Audio-Inhalt. Er kann die Verbindung nicht mitlesen oder umleiten: Der Host prüft das Passwort per Challenge/Response (PBKDF2-SHA256, 600 000 Runden), und die SDP/ICE-Nachrichten werden mit einem daraus abgeleiteten Sitzungsschlüssel authentifiziert. Ein manipulierter Server fällt dabei auf, die Verbindung kommt dann nicht zustande.

## 2. App installieren und verbinden

1. `ShareToFriends-Setup-<Version>.exe` installieren (oder aus `app/` selbst bauen, siehe unten). Beim ersten Start gibst du dir einen **Namen**.
2. Der Vermittlungs-Server ist **fest in der App eingebaut** (`wss://stf.s7venz.cloud/ws`): Er lässt sich nicht ändern und wird nirgends angezeigt. Wer einen eigenen Server betreiben will, ändert `FIXED_SERVER_URL` in `app/update-url.js` und baut die App neu.
3. Auf dem Startbildschirm wählst du einen von drei Wegen:
   - **Bildschirm teilen:** Du streamst. Deine **ID** und dein **Passwort** stehen links (auch unter *Einstellungen → Profil*) und gehören deinen Freunden.
   - **Zuschauen:** ID und Passwort des Freundes eingeben und mit **Enter** oder dem Knopf verbinden. Teilt er noch nichts, wartest du im **Warteraum**.
   - **Fernsteuern:** wie Zuschauen, aber die App fragt direkt nach dem Verbinden nach Zugriff; sobald dein Freund „Ja“ sagt, übernimmst du die Steuerung (**F8** gibt sie jederzeit frei).
4. Bei **„Zuletzt verbunden“** reicht ein Klick, um dich erneut zu verbinden; der kleine Zeiger-Knopf daneben verbindet und steuert gleich.

Das Passwort ändert sich per Knopfdruck (↻) jederzeit; die ID bleibt gleich.

## Funktionen

**Stream (Discord-Stil)**
- Fenster **oder** Monitor teilen; Wechsel während des Streams per Klick ohne Neuverbindung (gemessen ≈ 0,3 s).
- Schwebende Stream-Leiste unten beim Zuschauer: Lautstärke, Zoom, Qualitätsdeckel, Mauszeiger/Zeichnen/Bilder, **Vollbild** (Taste **F** oder **F11**, Doppelklick aufs Bild; **Esc** beendet). Das Bild ist immer eingepasst; mit dem **Mausrad** zoomst du wie bei Discord an die Stelle unter dem Zeiger (bis 8×), mit gedrückter Maustaste verschiebst du den Ausschnitt, Zurückdrehen oder ein Klick auf die Anzeige oben rechts führt wieder auf „angepasst“.
- Vollautomatische Qualität: Die App nutzt die Überlastregelung von WebRTC und zusätzlich einen **Ping-Schutz**: Steigt die Latenz der Leitung des Hosts (Bufferbloat, z. B. weil ein Spiel Bandbreite braucht), drosselt der Stream selbst und geht danach von allein wieder auf die höchste Stufe. Wählbar sind **alle Auflösungen (1080p, 720p, 540p, 360p) mit 60, 30 oder 15 FPS**: Der **Streamer** stellt „Auto bis …“ (Obergrenze, die App regelt darunter selbst) oder „Fest“ (die Stufe wird gehalten, dann ohne Ping-Schutz), jeder **Zuschauer** seine eigene Obergrenze; es gilt jeweils die niedrigere.
- H.264 bevorzugt (Hardware-Encoder, falls vorhanden), VP8 als Rückfall; Opus-Stereo 128 kbit/s.

**Audio**
- Kein Mikrofon, keine Kamera. Es wird nur Anwendungs-/Systemton übertragen.
- Mischpult mit Pegelanzeige je App, Modus **Alles / nur ausgewählte (Whitelist) / alle außer ausgewählten (Blacklist)** per Häkchen. Pro-App-Erfassung über Windows-Prozess-Loopback.
- Zuschauer regelt seine Lautstärke getrennt (wirkt nur bei ihm).

**Fernsteuerung (optional, nur mit Bestätigung)**
- Zuschauer klickt „Steuerung anfragen“ → beim Host erscheint immer ein Dialog: *„Zugriff für [Name] erlauben? [Ja] [Nein]“*.
- **Immer ein Ausweg für den Zuschauer:** **F8** gibt Maus und Tastatur sofort frei; außerdem erscheint beim Bewegen der Maus an den oberen Rand eine Leiste (kleiner Pfeil bleibt sichtbar) mit „Steuerung freigeben“, „Vollbild verlassen“ und „Stream verlassen“.
- Dauerhafte Leiste „Remote-Zugriff aktiv“ mit „Sofort beenden“; **F12** am Host-PC ist der Notaus (global per Low-Level-Tastaturhook erkannt, solange jemand fernsteuert).
- Maus, Tastatur inkl. Windows-Taste/Alt+Tab/Strg+C/V, **Zwischenablage in beide Richtungen (Text und Bilder)**.
- **Mauszeiger:** Dein Freund sieht deinen Zeiger als ganz normalen weißen Windows-Pfeil in Standardgröße (mit kleinem Namensschild) und kann so genau verfolgen, was du tust. Es gibt dafür keine Einstellungen. Taste **M**.
- **Zeichnen** mit **Bleistift** (dünn), **Filzstift** (kräftig) oder **Marker** (breit, durchscheinend); **beliebige Farbe** (10 Vorgaben plus Farbwähler) und **Dicke** per Regler (Farbe und Dicke gelten für beide Modi). Zwei Modi: *verblasst* (Taste **P**) und *bleibt* (Taste **O**). **C** löscht deine Zeichnungen. Der Host hat einen Knopf **„Desktop leeren“**.
- **Bilder:** Lege ein Bild (z. B. ein Meme) auf den Bildschirm des Streamers: Knopf in der Leiste, **Strg+V** (Bild aus der Zwischenablage) oder Drag & Drop (Taste **B**). Du kannst es **verschieben**, an den Ecken **skalieren**, am Punkt oben **drehen** (Umschalt = 15°-Schritte) und mit gedrückter **Alt-Taste an einer Ecke oder Kante ziehen, um frei zuzuschneiden** (nach außen ziehen nimmt den Zuschnitt zurück). Mausrad ändert die Größe, *Zuschnitt zurücksetzen* und *Entfernen* gibt es im Panel. Der Streamer sieht das Bild sofort auf seinem Desktop (es ist auch im Stream). Höchstens 8 Bilder je Zuschauer, jedes wird auf 1600 px verkleinert.

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

- **App-Ton von anderen Geräten:** Windows kann den Ton einer App nur abgreifen, wenn sie auf dem **Windows-Standard-Wiedergabegerät** spielt. Läuft sie über ein anderes Gerät (z. B. Spotify über „SteelSeries Sonar – Media“ oder einen GoXLR-Kanal), zeigt das Mischpult ein ⚠ mit der Anleitung; Lösung: im Windows-Lautstärkemixer das Ausgabegerät der App auf „Standard“ stellen.
- **60 FPS:** Die Aufnahme nutzt die klassische Desktop-Aufnahme von Chromium, weil `getDisplayMedia` auf Windows bei etwa 53 Bildern pro Sekunde hängen bleibt. Das tatsächliche Ergebnis hängt trotzdem von Bildschirm, Encoder (Hardware-H.264) und Upload ab.
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

### Updates über deinen Server

Die App fragt für Updates **nur deinen Server** ab (`https://<deine-domain>/updates`, abgeleitet aus dem fest eingebauten Server) und installiert sie im Hintergrund. Sie spricht nie mit GitHub.

So kommt eine neue Version zu den Apps:

1. `.\release.ps1 2.0.8` auf dem PC: setzt die Version, führt die Tests aus, committet, setzt das Tag und pusht.
2. **GitHub Actions** ([.github/workflows/release.yml](.github/workflows/release.yml)) baut den Windows-Installer und legt ihn mit `latest.yml` als Release ab (dort bleiben nur die neuesten zwei).
3. Der Dienst **updates-sync** auf dem Server holt die neue Version innerhalb von höchstens 5 Minuten, **prüft die SHA-512-Prüfsumme** des Installers gegen `latest.yml`, stellt Installer und Blockmap bereit und die `latest.yml` zuletzt. Auf dem Server bleiben nur die neuesten zwei Versionen.
4. Die Apps laden das Update im Hintergrund und **starten sich selbst neu**, sobald nichts geteilt oder angesehen wird.

Stimmt die Prüfsumme nicht oder ist GitHub nicht erreichbar, bleibt auf dem Server alles, wie es war; es wird beim nächsten Durchlauf erneut versucht. Logs: `docker logs stf-updates-sync`.

In den **Einstellungen → Updates** siehst du die installierte Version, wann zuletzt geprüft wurde und ob ein Update bereitsteht. Dort schaltest du auch „Automatisch aktualisieren“ an oder aus und kannst jederzeit „Jetzt prüfen“ klicken. Geprüft wird beim Start und danach alle 10 Minuten. Eine Update-Adresse muss man nicht eintragen.

### Server testen

```bash
cd server
npm ci
node test.js             # Signaling-Tests (Authentifizierung, Rate-Limits, Relay)
node update-sync.test.js # Update-Spiegel (Prüfsumme, Aufräumen, nur bekannte Dateinamen)
```

## Lizenz

MIT – siehe `LICENSE`.
