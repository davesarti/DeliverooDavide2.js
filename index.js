// Importa la funzione di connessione dall'SDK di Deliveroo.js
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';


import 'dotenv/config';
const host = process.env.HOST;
const token = process.env.TOKEN;

// Crea la connessione al server e restituisce il socket per comunicare con il gioco
const socket = DjsConnect(host, token);


// Oggetto che rappresenta lo stato corrente dell'agente (posizione, score, ecc.)
let me = {};

// Mappa dei pacchi visibili: chiave = id del pacco, valore = oggetto pacco {id, x, y, reward, carriedBy}
let parcels = new Map();

//Zone di consegna
let delivery_tiles = [];

// Zone di spawn
let spawn_tiles = [];

// Raggio di sensing dell'agente
let raggio_sensing;

// leggimao le zone di consegna 
socket.on('map', (width, height, tiles) => {
    // Filtra solo le tile di tipo delivery (ovvero di tipo 2)
    delivery_tiles = tiles.filter(t => t.type == 2);
    console.log("Tile di consegna:", delivery_tiles);

    let initial_time = Date.now();
    //mappa i tile di spawn e imposta il contatore visite a zero
    spawn_tiles = tiles.filter(t => t.type === 1).map(t => ({ ...t, ultima_visita: initial_time }));
    //console.log("Tile:", spawn_tiles);
    
});


// Riceve la configurazione del gioco appena connesso (es. distanza di sensing, durata azioni, ecc.)
socket.onConfig((config) => {
    raggio_sensing = config.GAME.player.observation_distance;
});


// Riceve i dati aggiornati dell'agente ogni volta che cambiano (es. dopo un movimento)
socket.onYou((m) => {
    me = m;  // Aggiorna lo stato locale dell'agente
    //aggiorna il contatore visite
    aggiorna_visita_celle(me);
    //console.log('Me:', me);
});


// Riceve il sensing ogni volta che qualcosa cambia nell'area visibile dell'agente
socket.onSensing((sensing) => {
    parcels.clear();
    // Itera su tutti i pacchi attualmente visibili e li salva nella mappa
    // Se un pacco era già presente, viene sovrascritto con i dati aggiornati (es. reward diminuito)
    for (const p of sensing.parcels) {
        parcels.set(p.id, p);
    }
    //console.log('Parcels visibili:', sensing.parcels);
});

function gaussian_weight(distance, sigma) {
    return Math.exp(- (distance * distance) / (2 * (sigma * sigma)));
}

function aggiorna_visita_celle(posizione_agente) {

    //configurazione sensing non disponibile, non aggiorno le visite
    if (raggio_sensing === undefined) {
        return;
    }

    const now = Date.now();
    const sigma = raggio_sensing / 2;
    const celle_raggio = spawn_tiles.filter(t => calcola_distanza(t, posizione_agente) <= raggio_sensing);

    for (let d_tile of celle_raggio) {
        const d = calcola_distanza(d_tile, posizione_agente);
        const f = gaussian_weight(d, sigma);
        
        // Avvicina il timestamp a "now" in proporzione alla vicinanza
        d_tile.ultima_visita = now - (now - d_tile.ultima_visita) * f;
    }
}

function calcola_distanza(posizione_pacco, posizione_agente) {
    
    return Math.abs(posizione_pacco.x - posizione_agente.x) + Math.abs(posizione_pacco.y - posizione_agente.y);

}

function pacchi_vicini(vettore_posizione_pacchi, posizione_agente) {
    let distanza_dai_pacchi = [];
    
    for (const pacco of vettore_posizione_pacchi){
        // Pusha un oggetto con distanza E id insieme
        if(pacco.carriedBy == null){
            distanza_dai_pacchi.push({
            id: pacco.id,
            distanza: calcola_distanza(pacco, posizione_agente),
            x: pacco.x,
            y: pacco.y
            });
        }
    }

    distanza_dai_pacchi.sort((a, b) => a.distanza - b.distanza);

    return distanza_dai_pacchi;
    
}

function delivery_vicini(vettore_posizione_delivery, posizione_agente) {
    let distanza_delivery = [];
    
    for (const zona_n of vettore_posizione_delivery){
        distanza_delivery.push({
        distanza: calcola_distanza(zona_n, posizione_agente),
        x: zona_n.x,
        y: zona_n.y
        });
    }

    distanza_delivery.sort((a, b) => a.distanza - b.distanza);

    return distanza_delivery; 
}

function spawn_tile_vicini(vettore_posizione_spawn_tile, posizione_agente) {
    let distanza_spawn = [];
    
    for (const zona_n of vettore_posizione_spawn_tile){
        distanza_spawn.push({
        distanza: calcola_distanza(zona_n, posizione_agente),
        x: zona_n.x,
        y: zona_n.y,
        ultima_visita: zona_n.ultima_visita
        });
    }

    distanza_spawn.sort((a, b) => a.distanza - b.distanza);

    return distanza_spawn; 
}

// Raggiungi una destinazione passo dopo passo
async function go_to(destinazione_x, destinazione_y) {
    while (true) {
        // Aggiorna me.x/me.y dopo ogni movimento tramite onYou
        const dx = destinazione_x - Math.round(me.x);
        const dy = destinazione_y - Math.round(me.y);

        // Sei arrivato se entrambe le differenze sono 0
        if (dx === 0 && dy === 0) break;

        // Muoviti prima sull'asse con distanza maggiore
        if (Math.abs(dx) >= Math.abs(dy)) {
            await socket.emitMove(dx > 0 ? 'right' : 'left');
        } else {
            await socket.emitMove(dy > 0 ? 'up' : 'down');
        }
    }
    //console.log('Destinazione raggiunta!');
}

// Trova la cella di spawn migliore da esplorare,
// bilanciando il tempo trascorso dall'ultima visita e la distanza dall'agente
function trova_cella_da_esplorare() {

    // Prendi tutte le spawn tile con distanza e ultima_visita,
    // ed escludi la cella su cui l'agente si trova già
    let distanza_spawn_tile = spawn_tile_vicini(spawn_tiles, me)
        .filter(t => !(t.x === me.x && t.y === me.y));

    const now = Date.now();

    // Calcola il massimo della distanza tra tutte le spawn tile e l'agente
    const distanza_max = Math.max(...spawn_tiles.map(t => calcola_distanza(t, me)));

    // Calcola il massimo del tempo trascorso dall'ultima visita tra tutte le spawn tile
    const tempo_passato_max = Math.max(...spawn_tiles.map(t => now - t.ultima_visita));

    distanza_spawn_tile.sort((a, b) => {

        // Tempo trascorso dall'ultima visita per le celle a e b (in ms)
        const tempo_a = now - a.ultima_visita;
        const tempo_b = now - b.ultima_visita;

        // Normalizza il tempo tra 0(non urgente) e 1(urgente)
        const tempo_norm_a = tempo_a / tempo_passato_max;
        const tempo_norm_b = tempo_b / tempo_passato_max;

        // Normalizza la distanza tra 0(non conveniente) e 1(conveniente):
        const dist_norm_a = 1 - (a.distanza / distanza_max);
        const dist_norm_b = 1 - (b.distanza / distanza_max);

        const alpha = 0.8; // 50% tempo, 50% distanza

        // Score finale: vogliamo massimizzare il tempo trascorso e minimizzare la distanza
        const score_a = alpha * tempo_norm_a + (1 - alpha) * dist_norm_a;
        const score_b = alpha * tempo_norm_b + (1 - alpha) * dist_norm_b;

        // Ordine decrescente: la cella con score più alto viene prima
        return score_b - score_a;
    });

    // LOG TEMPORANEO
    console.log(distanza_spawn_tile.slice(0, 10).map(t => ({
        x: t.x, y: t.y,
        tempo: now - t.ultima_visita,
        distanza: t.distanza
    })));

    // Restituisce la cella con lo score più alto (indice 0 dopo l'ordinamento decrescente)
    return distanza_spawn_tile[0];
}

// Funzione asincrona che gestisce il loop principale di movimento dell'agente
async function loop() {

    while (true) {
        // Aspetta che la mappa e la posizione siano state ricevute dal server
        if (spawn_tiles.length === 0 || delivery_tiles.length === 0 || me.x === undefined || raggio_sensing === undefined) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
        }

        //console.log("Numero pacchi:", parcels.size);
        
        if (parcels.size != 0) {
            
            let distanza_dai_pacchi = pacchi_vicini(Array.from(parcels.values()), me);

            // 1. Vai al pacco
            await go_to(distanza_dai_pacchi[0].x, distanza_dai_pacchi[0].y);
            // 2. Raccoglilo
            await socket.emitPickup();
            // 3. Vai alla delivery più vicina
            let delivery_vicine = delivery_vicini(delivery_tiles, me);
            await go_to(delivery_vicine[0].x, delivery_vicine[0].y);
            // 4. Consegna
            await socket.emitPutdown();

        } else {
            let tile = trova_cella_da_esplorare();
            await go_to(tile.x, tile.y);
        }

        await new Promise(resolve => setTimeout(resolve, 100));

    }
}


// Avvia il loop di movimento
loop();
