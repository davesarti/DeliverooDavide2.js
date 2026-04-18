// Importa la funzione di connessione dall'SDK di Deliveroo.js
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

// Importa host (indirizzo server) e token (autenticazione) dal file di configurazione
import { host, token } from './config.js';


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

// leggimao le zone di consegna 
socket.on('map', (width, height, tiles) => {
    // Filtra solo le tile di tipo delivery (ovvero di tipo 2)
    delivery_tiles = tiles.filter(t => t.type === 2);
    //mappa i tile di spawn e imposta il contatore visite a zero
    spawn_tiles = tiles.filter(t => t.type === 1).map(t => ({ ...t, visite: 0 }));
    //console.log("Tile:", spawn_tiles);
    
});


// Riceve la configurazione del gioco appena connesso (es. distanza di sensing, durata azioni, ecc.)
socket.onConfig((config) => {
    //console.log('Config:', config);
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

function aggiorna_visita_celle(posizione_agente) {

    for(let d_tile of spawn_tiles){
        if(d_tile.x === posizione_agente.x && d_tile.y === posizione_agente.y) {
            d_tile.visite++;
        }
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
        visite: zona_n.visite
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

// Trova la zona della mappa da esplorare 
function trova_cella_da_esplorare() {

    let distanza_spawn_tile = spawn_tile_vicini(spawn_tiles, me).filter(t => !(t.x === me.x && t.y === me.y));

    const distanza_max = Math.max(...spawn_tiles.map(t => calcola_distanza(t, me)));
    const visite_max = Math.max(...spawn_tiles.map(t => t.visite));
    const peso = visite_max > 0 ? distanza_max / visite_max : 1;

    distanza_spawn_tile.sort((a, b) => 
        (a.distanza + a.visite * peso) - (b.distanza + b.visite * peso)
    );

    return distanza_spawn_tile[0];
}

// Funzione asincrona che gestisce il loop principale di movimento dell'agente
async function loop() {

    while (true) {
        // Aspetta che la mappa e la posizione siano state ricevute dal server
        if (spawn_tiles.length === 0 || delivery_tiles.length === 0 || me.x === undefined) {
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

            await new Promise(resolve => setTimeout(resolve, 100)); 
        } else {
            let tile = trova_cella_da_esplorare();
            await go_to(tile.x, tile.y);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

// Avvia il loop di movimento
loop();