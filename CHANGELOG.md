# Changelog

## 2.0.1

- **Stream-Leiste:** bricht in normalen Fenstern nicht mehr um (einzeilig bis etwa 700 px Breite, in schmalen Fenstern nur Symbole).
- **Vollbild:** Taste **F** oder **F11**, Doppelklick aufs Bild oder der Knopf in der Leiste; **Esc** beendet.
- **Mauszeiger statt Laserpointer:** der Freund sieht deinen Zeiger (Pfeil mit Namensschild) in deiner Farbe.
- **Zeichnen:** Bleistift, Filzstift und Marker, beliebige Farbe (Farbwähler), einstellbare Größe; die Auswahl wird gespeichert.
- **Audio-Mischpult:** zeigt jetzt auch Apps, die auf einem anderen Gerät als dem Windows-Standard abspielen (z. B. Spotify über GoXLR/Sonar).
- **Updates:** Standardquelle sind die GitHub-Releases (`release.ps1` + GitHub Actions).

## 2.0.0

Komplett neue Architektur (der LiveKit-/Raspberry-Pi-Ansatz und alle Router-Port-Freigaben entfallen).

- **Verbindung:** ID + Passwort (wie TeamViewer) über einen kleinen Signaling-VPS, danach direkte WebRTC-P2P-Verbindung; TURN-Rückfall über coturn.
- **Sicherheit:** gegenseitige Passwort-Prüfung per PBKDF2-Challenge/Response, SDP/ICE mit Sitzungsschlüssel gesichert, kein Passwort auf dem Server.
- **Automatische Qualität:** Stufenleiter mit Ping-Schutz (Bufferbloat-Erkennung) und CPU-Schutz; keine manuellen Bitraten-/Codec-Regler mehr.
- **Oberfläche:** neues Discord-Design, schwebende Stream-Leiste (Lautstärke, Zoom, Qualitätsdeckel), sofortiger Wechsel zwischen Fenstern/Monitoren.
- **Audio:** kein Mikrofon/Kamera; Mischpult mit Whitelist/Blacklist je App und Pegelanzeigen; getrennte Zuschauer-Lautstärke.
- **Fernsteuerung:** Bestätigungsdialog, Dauer-Leiste, F12-Notaus, Zwischenablage (Text + Bilder) in beide Richtungen, Laserpointer, temporäre und dauerhafte Zeichnungen, „Desktop leeren“.
- **Updater:** Hintergrund-Updates aus `https://<server>/updates` oder `github:owner/repo`.
- **Electron 45:** Zwischenablage nutzt die neue asynchrone API.
