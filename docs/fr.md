# Systemair SAVE pour Gladys

Affiche une ventilation double flux **Systemair SAVE** (VTR, VSR, VSC à
régulation SAVE, panneau SAVE Touch ou SAVE Light) dans Gladys, en **Modbus
TCP** sur votre réseau local, sans cloud ni compte. Intégration non
officielle, **sans lien avec Systemair**. **Jamais testé avec un vrai
appareil** : elle lit et écrit les registres de la « Modbus Variable List »
de Systemair (révision 36, logiciel de carte mère 2.0) comme les utilise
l’intégration libre home-assistant-systemair-modbus (Home Assistant) ;
merci de signaler ce que vous observez.

## Avant de commencer

La régulation SAVE parle Modbus RTU sur sa carte de raccordement (RS485).
Gladys la joint sur votre réseau par l’un de ces moyens :

- **Systemair SAVE Connect** (le module d’accès Internet, art. 211243) :
  choisissez « Systemair SAVE Connect » comme passerelle. La liste de
  Systemair indique que tous les registres sont des registres de maintien en
  Modbus TCP : tout est lu en fonction 3, deux registres par requête, avec
  une pause entre les requêtes.
- **Une passerelle RS485 vers Modbus TCP** (Elfin EW11 et semblables),
  câblée sur les bornes Modbus de la centrale : choisissez « Passerelle
  RS485 ». Les registres d’entrée sont lus en fonction 4 ; si la passerelle
  répond « fonction illégale », la fonction 3 est utilisée ensuite (le
  statut le signale).

Ensuite :

- Donnez une adresse IP fixe à la passerelle dans votre routeur ; le Modbus
  TCP est sur le port 502 sauf si vous en ajoutez un autre
  (`192.168.1.50:8899`).
- Le Modbus TCP n’a **pas de mot de passe** : gardez la passerelle sur un
  réseau de confiance.
- L’identifiant d’unité Modbus est l’adresse Modbus de la centrale
  (Service, Communication, Modbus sur son panneau), 1 par défaut. Une
  réponse portant un autre identifiant est acceptée.
- **« Arrêter la ventilation » demande le réglage « Allow manual fan
  stop »** (registre 1353) sur la centrale : sans lui, la centrale refuse
  l’arrêt et Gladys le dit (le statut l’affiche aussi).

## Installation

1. Installez l’intégration depuis le store de Gladys.
2. Saisissez l’**adresse IP de la passerelle**, choisissez son type ;
   enregistrez.
3. Ouvrez l’onglet **Découverte** et ajoutez la centrale.

## Ce que vous obtenez

Un appareil, **Ventilation Systemair**, avec :

| Fonctionnalité                                        | Remarques                                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Températures de l’air soufflé, extrait et extérieur   | °C (les sondes standard de la centrale)                                                                                                                     |
| Consigne de soufflage                                 | °C, en lecture seule                                                                                                                                        |
| Humidité de l’air extrait                             | % (la sonde standard de la centrale)                                                                                                                        |
| Sorties des ventilateurs de soufflage et d’extraction | %, en lecture seule                                                                                                                                         |
| Changement du filtre dans                             | jours ; non publié quand la centrale lit 0                                                                                                                  |
| Mode de ventilation                                   | liste : auto, manuel faible / normal / élevé, affluence, rafraîchissement, cheminée, absence, vacances                                                      |
| Mode en cours                                         | texte : `auto`, `manual`, `stopped`, `crowded`, `refresh`, `fireplace`, `away`, `holiday`, `cooker-hood`, `vacuum-cleaner`, `cdi1`-`cdi3`, `pressure-guard` |
| Ventilation en marche, ventilateurs en marche         | lecture seule, 1 = oui (« en marche » vaut 0 seulement en mode manuel au niveau arrêt)                                                                      |
| Alarme de type A, B, C                                | lecture seule, 1 = active                                                                                                                                   |
| Arrêt manuel autorisé                                 | lecture seule, le réglage de la centrale                                                                                                                    |
| Démarrer la ventilation (auto) / Arrêter              | boutons                                                                                                                                                     |

Une valeur hors des plages de la liste (sonde absente, -40 à 80 °C, 0 à
100 %) n’est jamais publiée : Gladys garde la dernière valeur connue. Les
vitesses des ventilateurs en tr/min et les débits d’air ne sont pas publiés
(pas d’unité correspondante dans Gladys). Les sondes accessoires (pièce,
régulateur supplémentaire, CO2) ne sont pas encore lues.

La centrale est lue toutes les 60 s (30 s à 1 h), en une douzaine de petites
requêtes sur une connexion, avec une pause entre elles (le panneau tactile
partage le bus), fermée ensuite. Le bouton de test, une recherche dans
Découverte, une reconnexion de Gladys ou un redémarrage de l’intégration ne
la lisent jamais avant l’intervalle. Les commandes et les arrêts font la même
pause entre leurs requêtes quand leur échéance le permet. Lectures hors
intervalle :

- chaque commande relit la centrale juste avant d’écrire, puis relit le mode
  et le niveau ;
- « Arrêter la ventilation » et ses renvois ;
- 5 s puis 20 s après une commande non confirmée, ou après un arrêt qui suit
  un démarrage ou un mode non confirmé ;
- une nouvelle adresse, un nouvel identifiant d’unité ou une autre passerelle
  enregistrés sont lus aussitôt.

Le mode et le niveau manuel sont lus en premier. Quand un bloc suivant
échoue (exception Modbus, pas de réponse, connexion fermée, mauvaise
réponse), les valeurs lues avant sont publiées quand même, et le bloc en
échec est réessayé une fois par heure.

## Commandes

Le mode et « Démarrer la ventilation » sont refusés tant que **Autoriser
les commandes** n’est pas activé (désactivé par défaut). Pas
d’interrupteur : le « éteins tout » d’un assistant vocal n’atteint jamais
la ventilation.

- **Mode** : auto, affluence, rafraîchissement, cheminée, absence et
  vacances écrivent la demande de mode (registre 1162, comme le panneau) ;
  les modes temporisés durent le temps réglé sur la centrale. « Manuel,
  faible / normal / élevé » écrit le niveau manuel (1131), puis le mode
  manuel si la centrale n’y est pas encore.
- **Démarrer la ventilation (auto)** écrit le mode auto. Sur une ventilation
  déjà en marche, rien n’est écrit.
- Chaque commande relit la centrale juste avant d’écrire (mode, niveau
  manuel, réglages des niveaux de ventilation), n’écrit rien quand la valeur
  est déjà la bonne, et n’est confirmée que si la centrale renvoie l’écho de
  chaque écriture puis relit la valeur demandée. Une relecture qui montre
  encore l’état d’avant répond « pas encore appliquée » ; une commande qui a
  pu atteindre la centrale sans être confirmée répond « envoyée, sans
  confirmation » : vérifiez la centrale quelques secondes plus tard. Une
  exception Modbus 1, 2 ou 3 à la première écriture répond « refusée » (non
  appliquée) ; toute autre répond « envoyée, sans confirmation ». Une
  commande dont la première écriture ne peut pas partir dans les 3,5 s est
  refusée et rien n’est envoyé.
- Refusées aussi : quand les **réglages des niveaux de ventilation** relus
  diffèrent de ceux appris (voir plus bas), quand **/data** ne peut pas être
  lu ou écrit.
- Le **mode** est refusé tant que la ventilation est **arrêtée** (mode
  manuel, niveau arrêt : un mode la relancerait) et tant qu’un **arrêt
  envoyé depuis Gladys est gardé** : appuyez d’abord sur « Démarrer la
  ventilation ».

### Arrêter la ventilation

« Arrêter la ventilation » écrit le niveau manuel arrêt (1131 = 0), puis le
mode manuel (1162 = 2) : la centrale n’entre jamais en mode manuel à un
autre niveau. Il ne dépend **pas** de l’option, d’une autre commande (une
commande pas encore écrite est annulée, et la seconde écriture d’un niveau
manuel ne part jamais après lui), d’une lecture en cours ou bloquée (elle
est interrompue), d’une lecture en échec ou d’une attente entre deux essais,
des réglages des niveaux de ventilation, de /data, ni de la configuration
pas encore relue depuis Gladys ou devenue invalide (il part alors vers
l’adresse de l’arrêt gardé, sinon la dernière valide gardée dans /data). Il
est réessayé pendant 3,5 s après l’appui.

Il ne peut échouer que dans ces cas, et la réponse le dit :

- aucune adresse connue (jamais d’adresse valide configurée) : « non
  envoyée » ;
- la passerelle injoignable pendant 3,5 s : « arrêt non envoyé » (ou « pas
  encore envoyé » tant qu’il essaie) ; l’arrêt est gardé et renvoyé par les
  lectures suivantes ;
- la connexion se ferme, ou aucune réponse ne vient, avant que la centrale
  réponde : « arrêt remis à la passerelle, sans réponse de la centrale »
  (il n’est peut-être pas arrivé) ; gardé et renvoyé ;
- la centrale refuse le niveau arrêt par une exception Modbus 1, 2 ou 3
  (3 : « Allow manual fan stop » est désactivé sur la centrale) : « refusé » ;
  le mode manuel n’est pas envoyé, et l’arrêt **n’est pas gardé** (ni en
  attente ni renvoyé, le mode n’est pas bloqué ; le statut le dit jusqu’à
  l’appui suivant) ;
- le niveau arrêt appliqué et le mode manuel refusé (exception 1, 2 ou 3) :
  dit tel quel ; gardé et renvoyé ;
- toute autre exception Modbus (4 à 6…), un mauvais écho, ou la ventilation
  relue en marche : « arrêt envoyé, sans confirmation » ; gardé et renvoyé.

L’arrêt est ensuite **gardé** (dans /data, avec l’adresse) : il n’est
jamais levé par le temps, seulement par un appui sur « Démarrer la
ventilation » (avec l’option), ou quand la ventilation est relue en marche
**deux fois de suite** après l’avoir vue arrêtée (relancée depuis son
panneau). Tant qu’il est gardé, une lecture qui trouve la ventilation en
marche avant de l’avoir vue arrêtée renvoie l’arrêt : trois envois au plus,
en ne comptant que les envois **auxquels la centrale a répondu** (l’écho du
niveau arrêt, ou une exception Modbus) ; un renvoi qui trouve la passerelle
prise par un autre maître, une connexion fermée ou aucune réponse ne compte
pas.

Un arrêt pressé alors qu’un démarrage ou un mode peut encore arriver (écrit,
non confirmé, dans ses 90 s) est « collant » : il est renvoyé même après
avoir vu la ventilation arrêtée, jusqu’à ce qu’une lecture après ces 90 s le
voie appliqué. Un nouvel appui n’hérite jamais de cela d’un arrêt plus
ancien, et un démarrage fait ensuite au panneau n’est jamais combattu.

Le statut dit où en est l’arrêt : pas encore confirmé, gardé, ou abandonné
après trois envois ayant reçu une réponse. Un arrêt qui n’a peut-être pas
abouti quand l’intégration s’est arrêtée est renvoyé à son redémarrage,
avant même que la configuration soit relue. Si l’adresse a changé depuis,
il part vers la nouvelle adresse (jamais réécrit vers l’ancienne) ; un arrêt
déjà vu appliqué à l’ancienne adresse est oublié.

## Identité de la centrale

La liste Modbus de Systemair ne donne ni numéro de série ni adresse MAC.
L’appareil est donc lié à la centrale de la configuration, jamais à son
adresse IP (une nouvelle adresse garde l’appareil et son historique). Une
empreinte légère est apprise à la première lecture : les **réglages des
niveaux de ventilation** (registres 1401 à 1410). S’ils changent, une autre
centrale répond peut-être à l’adresse (ou les réglages ont été changés au
panneau) : le mode et le démarrage sont refusés jusqu’à ce que « Tester la
connexion » accepte les nouveaux réglages (l’arrêt n’en dépend pas). Deux
centrales aux mêmes réglages ne sont pas distinguées.

## /data

L’intégration garde dans `/data/systemair-state.json` (lisible par elle
seule) : l’heure de la dernière lecture, l’empreinte, la dernière adresse et
un arrêt gardé. Chaque lecture ou écriture de ce fichier est bornée (2,5 s
au plus) ; un fichier illisible (ou qui n’est pas un fichier ordinaire)
n’est jamais pris pour un fichier vide, et le mode et le démarrage sont
alors refusés ; l’arrêt l’attend 150 ms au plus avant son premier octet.

## Ce que l’intégration ne fait pas

Elle n’écrit jamais un réglage, l’horloge, le programme hebdomadaire, les
consignes, un mot de passe ; elle ne réinitialise jamais les alarmes, le
compteur du filtre ni les réglages d’usine. Seuls les registres 1131
(valeurs 0, 2, 3, 4) et 1162 (valeurs 1 à 7) sont écrits.
