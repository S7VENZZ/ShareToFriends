# Changelog

## 2.0.6

- **Echte 60 FPS:** Die Bildschirmaufnahme (`getDisplayMedia`) war auf Windows bei etwa 53 Bildern pro Sekunde gedeckelt, egal was angefordert wurde (gemessen, auch ohne Encoder). Die App nutzt jetzt die klassische Desktop-Aufnahme und kommt auf 60 FPS (gemessen: 59,8 FPS bei 1080p mit dem NVIDIA-Hardware-Encoder, vorher 52). `getDisplayMedia` bleibt als Rückfall.
- **Qualität frei wählbar:** 1080p, 720p, 540p und 360p jeweils mit 60, 30 oder 15 FPS, für den Streamer („Auto bis …“ oder „Fest“) und für jeden Zuschauer (Obergrenze).
- **Zoom wie bei Discord:** Mausrad zoomt an die Stelle unter dem Zeiger, Ziehen verschiebt, Zurückdrehen führt auf „angepasst“. Die Leiste „Anpassen / Füllen / 100 %“ ist weg, das Bild ist immer eingepasst.
- **Warteraum:** Zuschauer können sich verbinden, bevor der Streamer teilt, und bekommen den Stream automatisch, sobald er startet (auch nach einer Pause).
- **Ausweg aus der Fernsteuerung:** **F8** gibt Maus und Tastatur frei; am oberen Rand erscheint eine Leiste mit „Steuerung freigeben“, „Vollbild verlassen“, „Stream verlassen“ (kleiner Pfeil bleibt sichtbar). Man ist nicht mehr im Stream gefangen.
- **Bilder zuschneiden an Ecken und Kanten:** Alt gedrückt halten und an einer Ecke oder Kante ziehen; nach außen ziehen nimmt es zurück.
- **Minimierte Fenster** stehen in der Fensterliste und werden beim Teilen automatisch wiederhergestellt.
- **Mischpult:** Apps, die auf einem anderen Gerät als dem Windows-Standard spielen (Sonar, GoXLR …), werden mit ⚠ und einer Anleitung markiert, denn Windows kann deren Ton nicht abgreifen.

## 2.0.5

- **Update-Einstellungen vereinfacht:** Keine Update-Adresse mehr zum Eintragen, die App nutzt automatisch die GitHub-Releases. Die Einstellungen zeigen Version, „Zuletzt geprüft“ und Status; „Automatisch aktualisieren“ lässt sich an- und ausschalten. Geprüft wird beim Start und danach alle 10 Minuten.

## 2.0.4

- **Zuschauer entfernen:** Der Knopf in der Zuschauerliste wirft jemanden wirklich raus. Er wird informiert, verbindet sich nicht mehr von selbst und wird 30 Minuten lang abgewiesen, wenn er es von Hand versucht.

## 2.0.3

- **Passwort bleibt gespeichert:** ID und Passwort überleben Neustarts (Passwort verschlüsselt mit dem Windows-Konto). Es ändert sich nur per **↻** (neues zufälliges) oder **✎** (eigenes, dauerhaftes Passwort, 10–64 Zeichen). Nach 5 Fehlversuchen werden neue Anmeldungen 10 Minuten gesperrt, statt das Passwort zu ändern.
- **Zuletzt verbunden:** Freunde werden mit Name, ID und Passwort gespeichert (verschlüsselt, abschaltbar), ein Klick verbindet. Ändert sich das Passwort, fragt die App nach dem neuen.
- **Mauszeiger:** immer der normale weiße Windows-Pfeil in Standardgröße, ohne Farb- und Größen-Optionen.
- **Zeichnen:** Bleistift, Filzstift oder Marker, beliebige Farbe und Dicke – für „verblasst“ und „bleibt“.
- **Bilder:** per Knopf, Strg+V oder Drag & Drop auf den Bildschirm des Streamers legen; verschieben, skalieren, drehen und mit Alt + ziehen zuschneiden.
- **Qualität für den Streamer:** Auto (optional mit Obergrenze) oder feste Stufe (1080p60 / 720p60 / 720p30).
- **Updates starten die App selbst neu:** Ist ein Update geladen und du teilst/siehst gerade nichts, installiert die App es und startet automatisch neu (Banner „Später“ oder abgeschaltete Auto-Updates verhindern das). Läuft gerade ein Stream, wartet sie damit.
- **GitHub bleibt aufgeräumt:** Nach jedem Release bleiben nur die neuesten zwei Versionen übrig.
- Intern: verschlüsselter Speicher nutzt die neue asynchrone `safeStorage`-API von Electron 45.

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
