# Tentaplugget

Plugga gamla tentor som en inlämningsuppgift: en ändlig lista uppgifter som du tar en i taget, med en progress-bar som når 100 % först när allt är löst.

1. **Ladda upp** gamla tentor som PDF.
2. **Markera** varje uppgift (och facit, om det finns) genom att dra rutor över sidorna.
3. **Plugga**: en uppgift i taget som skarp bild. Markera den som *Klar* eller *Svår, kom tillbaka*.

Appen är en ren statisk webbplats (HTML, CSS och JavaScript-moduler). Den har ingen server, inget byggsteg, inga konton och ingen spårning. All data stannar i din webbläsare.

---

## Publicera på GitHub Pages (steg för steg)

1. Logga in på [github.com](https://github.com) och klicka **New repository**.
   - Ge det ett namn, t.ex. `tentaplugget`.
   - Välj **Public** (GitHub Pages på gratiskonton kräver publika repon).
   - Klicka **Create repository**.
2. Ladda upp filerna:
   - På repots startsida: **Add file → Upload files**.
   - Dra in **hela innehållet** i den här mappen: `index.html`, `sw.js`, `manifest.webmanifest`, `.nojekyll`, mapparna `css/`, `js/`, `icons/` och `vendor/`.
   - Mappstrukturen ska bevaras. Dra in mapparna, inte bara filerna inuti dem.
   - Klicka **Commit changes**.

   *Alternativ med git i terminalen:*
   ```bash
   git init && git add . && git commit -m "Tentaplugget" && git branch -M main
   ```
   ```bash
   git remote add origin https://github.com/<användare>/tentaplugget.git && git push -u origin main
   ```
3. Gå till **Settings → Pages**.
4. Under **Build and deployment → Source**: välj **Deploy from a branch**.
5. Under **Branch**: välj **main** och mappen **/ (root)**. Klicka **Save**.
6. Vänta en till två minuter. Ladda om sidan, så visas länken överst: `https://<användare>.github.io/tentaplugget/`.
7. Öppna länken. Klart!

Alla sökvägar i appen är relativa (`./css/styles.css`, `./sw.js` osv.), så den fungerar under `/<repo-namn>/` utan ändringar.

> **Obs:** `.nojekyll` är en tom fil som talar om för GitHub Pages att inte köra Jekyll. Den syns inte alltid i Finder (filer som börjar med punkt är dolda, tryck ⌘⇧. för att visa dem). Appen fungerar även utan den.

---

## PDF.js i `vendor/`

Appen läser PDF:er med [PDF.js](https://github.com/mozilla/pdf.js), låst till **version 4.10.38** (legacy-bygget, som fungerar i fler webbläsare, inklusive äldre iPhone). Filerna ligger i repot så att appen fungerar offline och inte beror på en CDN:

```
vendor/pdfjs/
  pdf.min.mjs            ← biblioteket
  pdf.worker.min.mjs     ← workern
  cmaps/                 ← teckenkartor (asiatiska typsnitt m.m.)
  standard_fonts/        ← standardtypsnitt för PDF:er utan inbäddade typsnitt
  LICENSE, VERSION.txt
```

**Om filerna saknas** (t.ex. om du bara laddade upp en del av mappen) försöker appen automatiskt hämta exakt samma version från jsDelivr. Det fungerar bara med internet, så lägg tillbaka filerna så här:

1. Ladda ner paketet: <https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz>
2. Packa upp det (dubbelklicka på macOS). Du får en mapp `package/`.
3. Kopiera in i `vendor/pdfjs/`:
   - `package/legacy/build/pdf.min.mjs`
   - `package/legacy/build/pdf.worker.min.mjs`
   - hela mappen `package/cmaps/`
   - hela mappen `package/standard_fonts/`
4. Ladda upp till GitHub igen.

Byter du PDF.js-version: ändra `PDFJS_VERSION` i `js/pdf.js` och namnet på `RUNTIME_CACHE` i `sw.js`.

---

## Installera som app

Appen är en PWA och kan installeras, så att den öppnas i ett eget fönster och fungerar utan nätverk.

- **iPhone/iPad (Safari):** öppna länken → tryck på **Dela** (fyrkanten med pil) → **Lägg till på hemskärmen** → **Lägg till**.
- **Android (Chrome):** öppna länken → menyn **⋮** → **Installera app** / **Lägg till på startskärmen**.
- **Dator (Chrome/Edge):** klicka på installationsikonen i adressfältet (en skärm med pil), eller menyn **⋮ → Installera Tentaplugget**.
- **Dator (Safari på macOS):** **Arkiv → Lägg till i Dock**.

En installerad app får dessutom oftare "skyddad lagring" av webbläsaren (se Inställningar i appen).

---

## Så använder du appen

### Markera uppgifter
1. Tryck **Markera uppgifter** på en tenta.
2. Välj läget **Markera** (på dator är det förvalt) och dra en ruta runt första uppgiften.
3. I panelen som dyker upp väljer du **Uppgift**, kontrollerar etiketten (t.ex. "Problem 1") och fyller i poäng om du vill. Tryck **Spara**.
4. Ligger facit direkt efter uppgiften: dra en ruta runt facit, välj **Facit** och vilken uppgift det hör till. Appen föreslår själv rätt typ och uppgift när du markerar i ordning.
5. Går en uppgift över flera sidor: tryck på uppgiftens ruta och sedan **Lägg till område**, och dra en ruta runt nästa del. Delarna visas under varandra när du pluggar. Samma sak gäller för facit (**Lägg till facitområde**).
6. Tryck på en ruta för att flytta den, ändra storlek (dra i hörnen), byta etikett/poäng, koppla facit till en annan uppgift eller ta bort den.
7. Listan **Uppgifter** (till höger på dator, knappen längst ned på mobil) visar alla uppgifter. Ändra ordning genom att dra i greppet ⋮⋮ eller med pilknapparna/menyn.
8. Klart? Tryck **Klar med markering** → **Plugga nu**.

**Tips på mobil:** I läget **Skrolla** skrollar du med ett finger. I läget **Markera** ritar ett finger rutor. Med **två fingrar** zoomar och flyttar du i båda lägena.
**Tips på dator:** Håll **Mellanslag** för att tillfälligt skrolla/dra sidan. **Ctrl/⌘ + Z** ångrar, **Ctrl/⌘ + Shift + Z** gör om, **Delete** tar bort vald ruta, **+ / − / 0** zoomar.

### Plugga
- **Klar** (K): uppgiften är löst. Den räknas in i progress-baren.
- **Svår, kom tillbaka** (S): den kommer tillbaka senare i kön. "Svår" räknas *inte* som klar, så 100 % nås bara när allt är klart.
- **Hoppa över** (H): ingen ändring, uppgiften läggs sist i kön.
- **Visa facit** (F): facit glider in under uppgiften.
- **Föregående** (←) och **Nästa** (→). **Esc** lämnar pluggläget. **?** visar alla kortkommandon.
- Varje statusbyte kan ångras i några sekunder via **Ångra** i meddelandet längst ned.
- Zooma bilden med två fingrar eller dubbeltryck (mobil) eller **Ctrl/⌘ + scroll** (dator).
- Under ⚙ (reglage-ikonen) väljer du **Väg efter poäng** och ordning (**Blandad**, **Kronologisk**, **Svåra först**).

### Säkerhetskopiera och flytta mellan enheter
Allt sparas automatiskt i webbläsarens databas (IndexedDB) direkt när du gör något. Det finns ingen spara-knapp.

- **Exportera:** Inställningar → **Exportera säkerhetskopia**. Du får *en* `.json`-fil med alla tentor (PDF:erna ingår), markeringar, framsteg och inställningar. Filnamnet innehåller datumet.
- **Importera:** Inställningar → **Importera**. Filen kontrolleras först. Sedan väljer du:
  - **Slå ihop**: lägger till det som saknas och behåller den senast ändrade versionen av varje uppgift. Inget tas bort.
  - **Ersätt allt**: tar bort allt på enheten och ersätter det med säkerhetskopian (du får bekräfta en gång till).
- **Flytta mellan dator och mobil:** exportera på den ena enheten, skicka filen till dig själv (AirDrop, mejl, molnet) och importera på den andra.
- Appen påminner diskret om du inte har exporterat på över 7 dagar.

---

## Släppa en ny version

Service workern cachar appen för offlinebruk och byter **inte** version tyst. När du har ändrat något:

1. Öka `VERSION` i **`sw.js`** (t.ex. `'1.0.0'` → `'1.0.1'`). Det är det som får webbläsarna att hämta den nya versionen.
2. Öka gärna `APP_VERSION` i **`js/version.js`** till samma nummer (det visas i appen).
3. Har du lagt till en ny fil i appen: lägg till den i listan `SHELL` i `sw.js`.
4. Ladda upp och committa. Inom några minuter visar appen bannern **"Ny version tillgänglig – Uppdatera"**. Tryck på den för att byta.

Ändrar du datamodellen: öka `SCHEMA_VERSION` i `js/db.js` och lägg till ett migreringssteg i `MIGRATIONS`. Ta aldrig bort gamla steg, så kan äldre data och säkerhetskopior alltid uppgraderas.

---

## Kända begränsningar

- **Datan är lokal per enhet och webbläsare.** Safari och Chrome på samma dator har olika data, och likaså en installerad app och en flik i Safari på iPhone. Synk mellan enheter sker via export/import.
- **Rensar du webbplatsdata** i webbläsaren försvinner allt. Exportera regelbundet.
- **Safari på iOS** kan rensa data för webbplatser du inte besökt på flera veckor, om appen *inte* är installerad på hemskärmen. Installera den, eller exportera regelbundet.
- **Privat/inkognito-läge** sparar inget permanent. Appen varnar direkt om lagring inte fungerar.
- **Lösenordsskyddade PDF:er** kan inte läsas. Ta bort lösenordet först (t.ex. genom att skriva ut som ny PDF).
- **Slå ihop** känner igen samma tenta via dess interna id. Laddar du upp samma PDF separat på två enheter blir det två olika tentor.
- Ingen AI-extraktion, ämnestaggning, timer eller automatisk synk i den här versionen.

---

## För utvecklare

```
index.html              App-skal
css/styles.css          Designsystem (CSS-variabler) och alla vyer
js/app.js               Start, hash-routing (#/, #/markera/<id>, #/plugga[/<id>], #/installningar), service worker
js/db.js                IndexedDB "tentaplugget-v1": tentor, PDF:er, uppgifter, logg, inställningar, migreringar
js/pdf.js               PDF.js-wrapper: laddning, sidrendering, uppgiftsbilder med minnescache (LRU)
js/library.js           Startsida, uppladdning, tentakort
js/marking.js           Markeringsläget
js/study.js             Pluggläget
js/stats.js             Progress, streak, "idag" (rena funktioner)
js/backup.js            Export/import av säkerhetskopior
js/settings.js          Inställningar
js/ui.js                DOM-hjälpare, ikoner, toasts, dialoger, menyer, zoomgester
js/theme.js             Ljust/mörkt tema
js/version.js           Versionsnummer som visas i appen
sw.js                   Service worker (versionerad cache)
manifest.webmanifest    PWA-manifest
icons/                  App-ikoner
vendor/pdfjs/           PDF.js 4.10.38
```

**Datamodell (kort):** Regioner lagras som `{ sida, x, y, w, h }`, normaliserade (0–1) mot sidans storlek, så de är oberoende av zoom. PDF:en lagras som `ArrayBuffer` i en egen store (`pdfs`) i stället för som Blob. Det är medvetet: Blobbar i IndexedDB har historiskt gått sönder i Safari på iOS, och tentalistan behöver då inte heller läsa in PDF-datan. Statusvärden: `"ej_gjord" | "klar" | "svår"`.

**Köra lokalt:** valfri statisk server från mappen, t.ex.

```bash
python3 -m http.server 8000
```

och öppna `http://localhost:8000/`. Tänk på att service workern cachar filerna. Under utveckling: DevTools → Application → Service workers → *Update on reload*.

**Bygga vidare:** nya vyer läggs till i `ROUTES` i `js/app.js`. Ny data i uppgifterna (t.ex. ämnestaggar eller tid) läggs till i `normalizeTask` i `js/db.js` med ett standardvärde, så att äldre data och säkerhetskopior fortsätter att fungera.
