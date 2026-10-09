# Tentaplugget

Plugga gamla tentor som en inlämningsuppgift: en ändlig lista uppgifter som du tar en i taget, med en progress-bar som når 100 % först när allt är löst.

1. **Ladda upp** gamla tentor som PDF.
2. **Granska**: appen hittar själv uppgifter, poäng och facit (gratis, lokalt, via PDF:ens text). Du godkänner eller justerar.
3. **Plugga**: en uppgift i taget som skarp bild. Tryck *Klar* eller *Svår*, tills det står 100 %.

Räcker inte den automatiska igenkänningen kan du markera uppgifterna själv, eller låta AI göra det (Premium, med din egen API-nyckel).

Appen är en ren statisk webbplats (HTML, CSS och JavaScript-moduler). Den har ingen server, inget byggsteg, inga konton och ingen spårning. All data stannar i din webbläsare – det enda undantaget är när du själv startar en AI-analys, då skickas tentans PDF till Anthropics API.

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

### Automatisk igenkänning (gratis, standard)
När du laddar upp en tenta går den igenom fyra steg, som visas per fil: **Läser tentan → Hittar uppgifter → Klipper ut figurer → Klar**. Allt sker i webbläsaren; inget lämnar enheten och ingen nyckel behövs. Laddar du upp en enda fil öppnas granskningen direkt.

**Så fungerar det:**
1. PDF:ens *textlager* läses sida för sida och delas upp i rader (sidhuvuden, sidfötter och sidnummer sorteras bort).
2. Rader som *börjar* med en rubrik blir kandidater: ord + nummer (*Problem 3.*, *Uppgift 4 (3 p)*, *Task*, *Question*, *Exercise*, *Övning*, *Fråga*, *Q2* …) eller, som reserv, bara ett nummer (*1.*, *1)*). Appen väljer den längsta stigande numreringen och hoppar över hänvisningar i löptext ("se Problem 2").
3. Poäng läses ut i alla vanliga format (*(3 p)*, *[3 p]*, *3 poäng*, *3 points*, *1,5 p*), även per deluppgift (a, b, c). Tentans angivna totalpoäng ("total of 25 points", "totalt 25 poäng") jämförs med summan.
4. Facit hittas efter *Solution:*, *Lösning:*, *Lösningsförslag*, *Svar:*, *Answer:* eller *Facit* (kräver kolon eller att ordet står ensamt), samlat på slutet efter *Lösningar*/*Solutions*, eller i en separat facit-PDF (⋯ → **Lägg till facit-PDF**).
5. Varje uppgift och facit klipps ut som egna rutor – en per sida om de går över flera sidor – och beskärs automatiskt mot innehållet. Omslag och avslutande rader ("Good luck", "Lycka till") kommer aldrig med.

**Begränsningar:** textigenkänningen kräver att PDF:en har ett textlager (inskannade PDF:er saknar det) och att uppgifterna har tydliga rubriker i början av raden. Ovanliga layouter (flera spalter, rubriker utan nummer) kan bli fel. Då föreslår appen AI-igenkänning eller manuell markering, och du väljer själv.

### Granska
Efter igenkänningen visas t.ex. **Hittade 7 uppgifter · 25 p**, vilken metod som användes och om poängen stämmer med tentans totalpoäng. Varje uppgift har en bricka: **Säker** eller **Behöver koll** (de osäkra visas överst, med en förklaring). Tryck på en uppgift för att se den stort, byta etikett/poäng, **slå ihop** med nästa, **dela** i två, **ta bort** eller **justera rutan** i markeringsvyn. Allt går att ångra. **Godkänn och börja plugga** när du är nöjd.

### Markera uppgifter själv
1. Tryck **⋯ → Markera manuellt** på en tenta (eller **Markera själv** i granskningen).
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
- **Klar** (K): uppgiften är löst. Den räknas in i progressen.
- **Svår** (S): den kommer tillbaka senare i kön. "Svår" räknas *inte* som klar, så 100 % nås bara när allt är klart.
- **Visa facit** (F): finns bara när uppgiften har facit. Facit är dolt tills du trycker.
- **Hoppa över** (H): ingen ändring, uppgiften läggs sist i kön.
- **Föregående** (←) och **Nästa** (→). **Esc** lämnar pluggläget. **?** visar alla kortkommandon.
- Varje statusbyte kan ångras i några sekunder via **Ångra** i meddelandet längst ned. Vid 25, 50 och 75 % visas en milstolpe, vid 100 % ett firande.
- Zooma bilden med två fingrar eller dubbeltryck (mobil) eller **Ctrl/⌘ + scroll** (dator).
- Under **⋯** väljer du **Väg efter poäng** och ordning (**Blandad**, **Kronologisk**, **Svåra först**). Dagsmålet ("Idag 2 av 3") ställer du in under Inställningar.

### Premium: AI-igenkänning (egen API-nyckel)
För tentor där textigenkänningen inte räcker – ovanliga layouter, rubriker utan nummer, inskannade PDF:er – kan Claude från Anthropic hitta uppgifterna. "Premium" är bara en etikett: det finns ingen betalning, inget konto och ingen server. Du använder din egen API-nyckel och betalar Anthropic direkt.

**Skaffa en nyckel:**
1. Skapa ett konto i [Anthropic Console](https://console.anthropic.com/).
2. Fyll på krediter under **Billing**.
3. Sätt en **utgiftsgräns** under **Limits** – då vet du vad det högst kan kosta.
4. Skapa en nyckel under **API Keys**.
5. I appen: tryck **Analysera med AI** (eller Inställningar → AI-igenkänning), klistra in nyckeln och tryck **Testa och spara**. Testet är ett gratis anrop som bara kontrollerar nyckeln.

**Kostnad:** vanligen några cent per tenta, beroende på antal sidor och modell – se [Anthropics prissida](https://www.anthropic.com/pricing#api). Samma tenta analyseras bara en gång: svaret sparas, så att en ny körning inte kostar något (⋯ → **Analysera om med AI** gör ett nytt anrop).

**Integritet:** nyckeln sparas bara i den här webbläsaren, i en egen del av databasen, och följer **aldrig** med i säkerhetskopior. När du startar en analys skickas tentans PDF (och facit-PDF:en, om du lagt till en) direkt från webbläsaren till Anthropics API. Inget annat lämnar enheten, och AI körs aldrig utan att du valt det.

**Så fungerar det:** modellen pekar ut *vad* som finns (uppgifter, poäng, deluppgifter och den exakta texten där varje uppgift och facit börjar). De exakta koordinaterna hämtas sedan ur PDF:ens textlager och klippen görs precis som i textigenkänningen. Hittas inte texten (t.ex. i en inskannad PDF) används modellens uppskattade ruta, och uppgiften märks **Behöver koll**. Resultatet ersätter det tidigare, framsteg bevaras på uppgifter med samma etikett, och **Ångra** återställer. Modell väljer du under Inställningar (standard: Sonnet).

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

1. Höj `VERSION` i **`sw.js`** (t.ex. `'2.0.0'` → `'2.0.1'`). Det är det som får webbläsarna att hämta den nya versionen.
2. Höj `APP_VERSION` i **`js/version.js`** till samma nummer (det visas i appen).
3. Har du lagt till en ny fil i appen: lägg till den i listan `SHELL` i `sw.js`.
4. Kör testerna (se nedan).
5. Ladda upp och committa. Inom några minuter visar appen bannern **"Ny version tillgänglig – Uppdatera"**. Tryck på den för att byta.

Ändrar du datamodellen: öka `SCHEMA_VERSION` i `js/db.js` och lägg till ett migreringssteg i `MIGRATIONS`. Ta aldrig bort gamla steg, så kan äldre data och säkerhetskopior alltid uppgraderas. (Version 2 lade till igenkänning, facit-PDF och API-nyckel; befintliga tentor och uppgifter fick metod/källa "manuell".)

Service workern cachar bara appens egna filer. Anrop till `api.anthropic.com` rörs aldrig.

---

## Kända begränsningar

- **Datan är lokal per enhet och webbläsare.** Safari och Chrome på samma dator har olika data, och likaså en installerad app och en flik i Safari på iPhone. Synk mellan enheter sker via export/import.
- **Rensar du webbplatsdata** i webbläsaren försvinner allt. Exportera regelbundet.
- **Safari på iOS** kan rensa data för webbplatser du inte besökt på flera veckor, om appen *inte* är installerad på hemskärmen. Installera den, eller exportera regelbundet.
- **Privat/inkognito-läge** sparar inget permanent. Appen varnar direkt om lagring inte fungerar.
- **Lösenordsskyddade PDF:er** kan inte läsas. Ta bort lösenordet först (t.ex. genom att skriva ut som ny PDF).
- **Slå ihop** känner igen samma tenta via dess interna id. Laddar du upp samma PDF separat på två enheter blir det två olika tentor.
- **Textigenkänningen** kräver textlager och tydliga rubriker i radens början (se ovan). Ingen OCR för inskannade PDF:er – använd AI-igenkänning eller markera själv.
- **AI-igenkänning** kräver internet och en egen API-nyckel. En PDF får vara högst cirka 23 MB och 600 sidor per anrop; dela upp större tentor.
- Ingen ämnestaggning, timer, AI-rättning av dina lösningar eller automatisk synk.

---

## För utvecklare

```
index.html              App-skal
css/styles.css          Designsystem (CSS-variabler) och alla vyer
js/app.js               Start, hash-routing (#/, #/granska/<id>, #/markera/<id>[/<uppgift>], #/plugga[/<id>], #/installningar), service worker
js/db.js                IndexedDB "tentaplugget-v1": tentor, PDF:er, facit-PDF:er, uppgifter, logg, inställningar, hemligheter, migreringar
js/pdf.js               PDF.js-wrapper: laddning, sidrendering, uppgiftsbilder med minnescache (LRU)
js/textlayer.js         PDF:ens textlager → rader (normaliserade koordinater, brus, fetstil)
js/detect.js            Igenkänning: rubriker, poäng, delmoment, facit, säkerhet (rena funktioner)
js/crop.js              Intervall → rektanglar per sida, autobeskärning mot pixlar (rena funktioner)
js/extract.js           Kör igenkänningen för en tenta och bygger uppgifter
js/analysis.js          Omanalys med stegvis förlopp, facit-PDF, Ångra
js/review.js            Granskningsvyn
js/ai.js                Claude API-klient (Premium): anrop, schema, validering, fel
js/premium.js           Premium-sheet, API-nyckel, AI-analysflödet
js/models.js            Modellval (standardmodellen står här och bara här)
js/library.js           Hem: progressring, tentakort, uppladdning, välkomstvy
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
icons/                  App-ikoner (symbolen: orange rundad kvadrat med vit bock)
vendor/pdfjs/           PDF.js 4.10.38
tests.html              Tester för igenkänning och klipp i webbläsaren
tests/                  Testsvit, konstruerade fixtures, kontrastskript
```

**Tester:** öppna `tests.html` (fungerar utan nätverk och utan nyckel), eller kör i terminalen:

```bash
node tests/run-node.mjs      # igenkänning och klipp mot konstruerade fixtures
node tests/contrast.mjs      # textkontraster mot WCAG AA, ljust och mörkt läge
```

Lägg aldrig riktiga tenta-PDF:er i repot (de kan vara upphovsrättsskyddade). Mappen `tests/lokalt/` är ignorerad av git för egna testfiler.

**Design:** alla färger, radier, typografi och den enda skuggan finns som CSS-variabler överst i `css/styles.css` (orange och vit, med mörkt läge). Inga färger hårdkodas utanför variablerna.

**Datamodell (kort):** Regioner lagras som `{ sida, x, y, w, h }`, normaliserade (0–1) mot sidans storlek med origo uppe till vänster, så de är oberoende av zoom (regioner i en separat facit-PDF har dessutom `pdf: "facit"`). Uppgifter har `delmoment`, `kalla` (`text`/`ai`/`manuell`), `sakerhet` (`hög`/`låg`/`manuell`) och `anmarkningar`; tentor har `extraktion` (metod, sammanfattning, cachat AI-svar) och `foregaendeUppgifter` (för Ångra). PDF:en lagras som `ArrayBuffer` i en egen store (`pdfs`) i stället för som Blob. Det är medvetet: Blobbar i IndexedDB har historiskt gått sönder i Safari på iOS, och tentalistan behöver då inte heller läsa in PDF-datan. Statusvärden: `"ej_gjord" | "klar" | "svår"`.

**Köra lokalt:** valfri statisk server från mappen, t.ex.

```bash
python3 -m http.server 8000
```

och öppna `http://localhost:8000/`. Tänk på att service workern cachar filerna. Under utveckling: DevTools → Application → Service workers → *Update on reload*.

**Bygga vidare:** nya vyer läggs till i `ROUTES` i `js/app.js`. Ny data i uppgifterna (t.ex. ämnestaggar eller tid) läggs till i `normalizeTask` i `js/db.js` med ett standardvärde, så att äldre data och säkerhetskopior fortsätter att fungera.
