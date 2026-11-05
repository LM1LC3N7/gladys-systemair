// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and mode names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Systemair ventilation', 'Ventilation Systemair');

export const FEATURE_NAMES = {
  [FEATURES.MODE]: both('Ventilation mode', 'Mode de ventilation'),
  [FEATURES.CURRENT_MODE]: both('Current mode', 'Mode en cours'),
  [FEATURES.POWER]: both('Ventilation on', 'Ventilation en marche'),
  [FEATURES.FAN_RUNNING]: both('Fans running', 'Ventilateurs en marche'),
  [FEATURES.ALARM_A]: both('Alarm type A', 'Alarme de type A'),
  [FEATURES.ALARM_B]: both('Alarm type B', 'Alarme de type B'),
  [FEATURES.ALARM_C]: both('Alarm type C', 'Alarme de type C'),
  [FEATURES.TEMP_SUPPLY]: both('Supply air temperature', 'Température de l’air soufflé'),
  [FEATURES.TEMP_EXTRACT]: both('Extract air temperature', 'Température de l’air extrait'),
  [FEATURES.TEMP_OUTDOOR]: both('Outdoor air temperature', 'Température de l’air extérieur'),
  [FEATURES.SETPOINT]: both('Supply air setpoint', 'Consigne de soufflage'),
  [FEATURES.HUMIDITY]: both('Extract air humidity', 'Humidité de l’air extrait'),
  [FEATURES.FAN_SUPPLY]: both('Supply fan output', 'Sortie du ventilateur de soufflage'),
  [FEATURES.FAN_EXTRACT]: both('Extract fan output', 'Sortie du ventilateur d’extraction'),
  [FEATURES.FILTER]: both('Filter change in', 'Changement du filtre dans'),
  [FEATURES.STOP_ALLOWED]: both('Manual stop allowed', 'Arrêt manuel autorisé'),
  [FEATURES.START]: both('Start the ventilation (auto)', 'Démarrer la ventilation (auto)'),
  [FEATURES.STOP]: both('Stop the ventilation', 'Arrêter la ventilation'),
};

/** The modes: those of the list, and those only read (register 1161). */
export const MODE_NAMES = {
  auto: both('Auto', 'Auto'),
  'manual-low': both('Manual, low', 'Manuel, faible'),
  'manual-normal': both('Manual, normal', 'Manuel, normal'),
  'manual-high': both('Manual, high', 'Manuel, élevé'),
  manual: both('Manual', 'Manuel'),
  stopped: both('Stopped', 'Arrêtée'),
  crowded: both('Crowded', 'Affluence'),
  refresh: both('Refresh', 'Rafraîchissement'),
  fireplace: both('Fireplace', 'Cheminée'),
  away: both('Away', 'Absence'),
  holiday: both('Holiday', 'Vacances'),
  'cooker-hood': both('Cooker hood', 'Hotte'),
  'vacuum-cleaner': both('Vacuum cleaner', 'Aspirateur'),
  cdi1: both('Digital input 1', 'Entrée numérique 1'),
  cdi2: both('Digital input 2', 'Entrée numérique 2'),
  cdi3: both('Digital input 3', 'Entrée numérique 3'),
  'pressure-guard': both('Pressure guard', 'Pressostat'),
};

/** The integration status and the answers of the button. */
export const T = {
  noHost: both(
    'Enter the IP address of your Modbus TCP gateway (Systemair SAVE), then save.',
    'Saisissez l’adresse IP de votre passerelle Modbus TCP (Systemair SAVE), puis enregistrez.',
  ),
  invalid: (length) =>
    both(
      `Invalid address (${length} characters): an IPv4 address or a host name, optionally with a port.`,
      `Adresse invalide (${length} caractères) : une adresse IPv4 ou un nom d’hôte, avec un port si besoin.`,
    ),
  otherUnit: both(
    'Connected, but the fan level settings of the unit changed: another unit may answer at this address. The mode and start commands are refused; if it is your unit, press "Test the connection" to accept it.',
    'Connecté, mais les réglages des niveaux de ventilation de la centrale ont changé : une autre centrale répond peut-être à cette adresse. Le changement de mode et le démarrage sont refusés ; si c’est bien votre centrale, appuyez sur « Tester la connexion » pour l’accepter.',
  ),
  accepted: both(
    'Unit accepted with its current fan level settings: the commands follow the option again.',
    'Centrale acceptée avec ses réglages actuels des niveaux de ventilation : les commandes suivent de nouveau l’option.',
  ),
  badUnitId: both(
    'Invalid Modbus unit id: a whole number from 1 to 247 (1 by default). Nothing is read.',
    'Identifiant d’unité Modbus invalide : un nombre entier de 1 à 247 (1 par défaut). Rien n’est lu.',
  ),
  configUnread: (wait) =>
    both(
      `The configuration could not be read from Gladys; next try in ${wait.en}.`,
      `La configuration n’a pas pu être lue depuis Gladys ; nouvel essai dans ${wait.fr}.`,
    ),
  dataUnreadable: both(
    ' /data cannot be read: the mode and start commands are refused until a restart reads it.',
    ' /data illisible : le changement de mode et le démarrage sont refusés jusqu’à un redémarrage qui le relise.',
  ),
  stopPending: both(
    ' A stop sent from Gladys is not confirmed yet: it is sent again when a read shows the ventilation running (three sends at most).',
    ' Un arrêt envoyé depuis Gladys n’est pas encore confirmé : il est renvoyé quand une lecture montre la ventilation en marche (trois envois au plus).',
  ),
  stopKept: both(
    ' A stop sent from Gladys is kept: until "Start the ventilation" is pressed or the ventilation is read running twice in a row after being seen stopped.',
    ' Un arrêt envoyé depuis Gladys est gardé : jusqu’à un appui sur « Démarrer la ventilation » ou deux lectures de suite en marche après l’avoir vue arrêtée.',
  ),
  stopNotApplied: both(
    ' WARNING: the stop sent from Gladys does not show on the unit after three sends; stop it on its panel.',
    ' ATTENTION : l’arrêt envoyé depuis Gladys n’apparaît pas sur la centrale après trois envois ; arrêtez-la depuis son panneau.',
  ),
  stopNotAllowed: both(
    ' The unit does not allow a manual stop (setting "Allow manual fan stop"): "Stop the ventilation" will be refused by the unit.',
    ' La centrale n’autorise pas l’arrêt manuel (réglage « Allow manual fan stop ») : « Arrêter la ventilation » sera refusé par la centrale.',
  ),
  fallback: both(
    ' The gateway refuses function 4: input registers are read as holding registers.',
    ' La passerelle refuse la fonction 4 : les registres d’entrée sont lus comme registres de maintien.',
  ),
  connecting: both('Reading the unit…', 'Lecture de la centrale…'),
  waiting: (wait) =>
    both(
      `Next read of the unit in ${wait.en} (never sooner than the refresh interval).`,
      `Prochaine lecture de la centrale dans ${wait.fr} (jamais avant l’intervalle de rafraîchissement).`,
    ),
  lastRead: (ago) => both(`Last read ${ago.en} ago.`, `Dernière lecture il y a ${ago.fr}.`),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (address, wait) =>
    both(
      `No answer from ${address} (next try in ${wait.en}). Check the address, the gateway, its Modbus TCP port and the Modbus unit id.`,
      `Pas de réponse de ${address} (nouvel essai dans ${wait.fr}). Vérifiez l’adresse, la passerelle, son port Modbus TCP et l’identifiant d’unité Modbus.`,
    ),
  failing: (reason, wait) =>
    both(
      `The unit answered badly (${reason}); next try in ${wait.en}.`,
      `La centrale a mal répondu (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  summary: (values) => {
    const name = 'Systemair SAVE';
    if (values.power === false) {
      return both(`${name}: ventilation stopped.`, `${name} : ventilation arrêtée.`);
    }
    const mode =
      MODE_NAMES[values.modeChoice] ??
      MODE_NAMES[values.mode] ??
      both('unknown mode', 'mode inconnu');
    const alarm = values.alarmA ? both(', ALARM A', ', ALARME A') : both('', '');
    return both(
      `${name}: ${mode.en.toLowerCase()}${alarm.en}.`,
      `${name} : ${mode.fr.toLowerCase()}${alarm.fr}.`,
    );
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Unknown value: not sent.', 'Valeur inconnue : non envoyée.'),
  badButton: both('A button only takes 1: not sent.', 'Un bouton ne prend que 1 : non envoyé.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    'Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l’intégration.',
  ),
  noHost: both(
    'No valid address or Modbus unit id in the configuration: not sent.',
    'Aucune adresse ou identifiant d’unité Modbus valide dans la configuration : non envoyée.',
  ),
  unitOff: both(
    'The ventilation is stopped: a mode would start it. Press "Start the ventilation" first. Not sent.',
    'La ventilation est arrêtée : un mode la relancerait. Appuyez d’abord sur « Démarrer la ventilation ». Non envoyée.',
  ),
  stopKept: both(
    'A stop sent from Gladys is kept: press "Start the ventilation" first. Not sent.',
    'Un arrêt envoyé depuis Gladys est gardé : appuyez d’abord sur « Démarrer la ventilation ». Non envoyée.',
  ),
  otherUnit: both(
    'The fan level settings of the unit changed: another unit may answer at this address. Press "Test the connection" to accept it. Not sent.',
    'Les réglages des niveaux de ventilation de la centrale ont changé : une autre centrale répond peut-être à cette adresse. Appuyez sur « Tester la connexion » pour l’accepter. Non envoyée.',
  ),
  noIdentity: both(
    'The fan level settings of the unit (its identity) could not be read just before: not sent.',
    'Les réglages des niveaux de ventilation de la centrale (son identité) n’ont pas pu être relus juste avant : non envoyée.',
  ),
  dataUnreadable: both(
    '/data cannot be read or written: not sent (a stop is never held back by this).',
    '/data ne peut pas être lu ou écrit : non envoyée (un arrêt n’est jamais bloqué par cela).',
  ),
  unknownMode: both(
    'The mode of the unit could not be read just before: command not sent.',
    'Le mode de la centrale n’a pas pu être relu juste avant : commande non envoyée.',
  ),
  unreadable: both('unreadable', 'illisible'),
  stopPending: both(
    'Stop not sent yet, still trying to reach the unit: it is kept and sent again by the next reads.',
    'Arrêt pas encore envoyé, la centrale n’est pas encore jointe : il est gardé et renvoyé par les lectures suivantes.',
  ),
  stopNotSent: (reason) =>
    both(
      `Stop not sent, the unit could not be reached (${reason}): it is kept and sent again when a read shows the ventilation running.`,
      `Arrêt non envoyé, la centrale n’a pas pu être jointe (${reason}) : il est gardé et renvoyé quand une lecture montre la ventilation en marche.`,
    ),
  stopNotAllowed: both(
    'The unit refused the stop: its setting "Allow manual fan stop" is off (change it on the unit). Not applied.',
    'La centrale a refusé l’arrêt : son réglage « Allow manual fan stop » est désactivé (à changer sur la centrale). Non appliqué.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: not sent.',
    'La configuration a changé entre-temps : non envoyée.',
  ),
  busy: both(
    'Another command to the unit is still running: not sent.',
    'Une autre commande vers la centrale est encore en cours : non envoyée.',
  ),
  protectMeanwhile: both(
    'The ventilation was stopped meanwhile: not sent.',
    'La ventilation a été arrêtée entre-temps : non envoyée.',
  ),
  tooSlow: both(
    'The unit answered too slowly to send the command in time: not sent.',
    'La centrale a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the unit could not be read just before (${reason}): command not sent.`,
      `L’état de la centrale n’a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The unit refused the command (${reason}): not applied.`,
      `La centrale a refusé la commande (${reason}) : non appliquée.`,
    ),
  notSent: (reason) =>
    both(
      `The unit could not be reached (${reason}): command not sent.`,
      `La centrale n’a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the unit in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l’état de la centrale dans quelques secondes.`,
    ),
  notYetApplied: both(
    'Command sent, the unit still reads the state from before: not applied yet, check in a few seconds.',
    'Commande envoyée, la centrale relit encore l’état d’avant : pas encore appliquée, vérifiez dans quelques secondes.',
  ),
};
