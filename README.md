# Market Radar — versione web

Cruscotto multi-mercato con login e operatività reale su un conto broker Alpaca.
È un **unico file `index.html` autonomo**: nessun build, nessuna dipendenza, nessun server richiesto.

## Pubblicare su GitHub Pages

1. Crea un repository (anche pubblico) e carica `index.html` nella radice.
2. Nel repository: **Settings → Pages**.
3. In *Source* scegli **Deploy from a branch**, branch `main`, cartella `/ (root)`, poi **Save**.
4. Dopo un minuto il sito è su `https://<tuo-utente>.github.io/<nome-repo>/`.

In alternativa, trascina il file nell'interfaccia web di GitHub: **Add file → Upload files**.

> Il login usa `crypto.subtle` (SHA-256), che il browser abilita solo su **https** o `localhost`.
> GitHub Pages serve in https, quindi funziona. Aprendo il file con doppio clic (`file://`)
> il browser blocca `crypto.subtle` e il codice ripiega su un hash non crittografico:
> va bene per provare l'interfaccia, non per un uso reale.

## Dove inserire le credenziali del broker

Nell'app, riquadro **"Conto broker · operatività reale"** (subito sotto i KPI):

| Campo | Cosa metterci |
|---|---|
| **API Key ID** | la chiave Alpaca, `PK…` per il conto demo, `AK…` per il conto reale |
| **API Secret** | la chiave segreta corrispondente (mostrata una volta sola alla creazione) |
| **Server proxy** *(opzionale)* | indirizzo del tuo backend che custodisce le chiavi |
| **Token del proxy** *(opzionale)* | il bearer token che il tuo backend si aspetta |

Poi premi **Collega il conto**. Le chiavi si ottengono su `alpaca.markets` → **API Keys**.

### Demo o reale

L'interruttore in cima al riquadro sceglie l'ambiente:

- **Demo (paper)** → `paper-api.alpaca.markets`, denaro finto. È il modo giusto per provare tutto.
- **Reale (live)** → `api.alpaca.markets`, **denaro vero, ordini irrevocabili**.

Dopo aver cambiato modalità bisogna ricollegare il conto perché venga applicata.

### Perché il proxy

Una chiave che può inviare ordini, se sta nel `localStorage` del browser, è leggibile da
chiunque usi quel computer. Per operare con denaro vero conviene un piccolo server che
custodisce le chiavi: il browser manda solo il percorso (`/v2/orders`), il server aggiunge
le credenziali. Il campo **Server proxy** fa esattamente questo.

## Cosa è negoziabile

Il broker collegato (Alpaca) tratta **azioni ed ETF statunitensi** e **criptovalute**.
Indici, valute e materie prime non sono negoziabili: l'app lo dice e suggerisce l'ETF
equivalente (GLD per l'oro, SPY per l'S&P 500, UUP per il dollaro). I listini esteri
(ASML.AS, 7203.T…) non sono disponibili.

## Dati e privacy

- Quotazioni da Yahoo Finance e CoinGecko, fonti pubbliche gratuite: possono essere
  ritardate (USA ~15 min, crypto 1–2 min) o temporaneamente irraggiungibili.
- L'account di login è **locale al browser**: password salvata solo come SHA-256 con sale.
  Non esiste recupero password; cancellando i dati del sito l'account sparisce.
- Le chiavi del broker restano nel `localStorage` di quel browser.

## Avvertenza

Strumento informativo. I punteggi sono un esercizio quantitativo su dati storici: non
prevedono il futuro. La modalità reale invia ordini veri: verifica simbolo, lato e
quantità nella finestra di conferma prima di procedere.
