# Simulazione sempre attiva (anche a computer spento)

Il file `worker.js` è un piccolo programma che gira su Cloudflare (gratuito) e ogni minuto
scarica le quotazioni crypto, calcola i segnali, esegue il ciclo di simulazione (soldi virtuali,
leva 10x) e salva lo stato. La pagina `index.html` mostra quello stato.

Nessun ordine reale viene mai inviato: è solo la simulazione.

## Installazione (circa 10 minuti)

1. Crea un account gratuito su cloudflare.com ed entra nella dashboard.
2. **Database.** Vai su *Storage & databases → D1 SQL database → Create*. Chiamalo `market-radar`.
   Aprilo, scheda *Console*, incolla ed esegui:
   `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);`
3. **Programma.** Vai su *Workers & Pages → Create → Start with Hello World*. Chiamalo
   `market-radar-sim` e premi *Deploy*. Poi *Edit code*, cancella tutto, incolla il contenuto di
   `worker.js` e premi *Deploy*.
4. **Collegare il database.** Nel Worker: *Settings → Bindings → Add → D1 database*.
   Nome variabile: `DB` (maiuscolo). Scegli `market-radar`. Salva.
5. **Password.** *Settings → Variables and secrets → Add*: tipo *Secret*, nome `ADMIN_TOKEN`,
   valore una password a tua scelta (serve solo per azzerare la simulazione).
6. **Ogni minuto.** *Settings → Trigger events → Cron triggers → Add* e inserisci `* * * * *`.
7. Copia l'indirizzo del Worker (finisce con `.workers.dev`). Aprilo aggiungendo `/state`:
   dopo un paio di minuti deve mostrare dati, non un errore.
8. Nella pagina, nel pannello Simulazione, incolla l'indirizzo nel campo **Server sempre attivo**
   e premi **Collega server**.

Da quel momento la simulazione avanza da sola, anche a computer spento. Quando riapri la pagina
trovi tutto aggiornato.

## Cosa sapere

- Il server copre solo le **crypto** (i mercati sono aperti 24 ore su 24). Azioni, ETF, indici e
  valute restano nella pagina e non fanno parte della simulazione sul server.
- Il ciclo è di 1 minuto (il minimo dei cron di Cloudflare). I prezzi ogni 10 secondi restano
  solo nella pagina aperta, per mostrare il profitto o la perdita in tempo reale.
- Soglia di ingresso: 68 (come nella pagina). Per cambiarla aggiungi la variabile `THRESHOLD`.
- Se un minuto le fonti non rispondono, quel ciclo viene saltato e lo stato resta quello di prima.
- Scollegando il server dalla pagina torna la simulazione locale, attiva solo a pagina aperta.
