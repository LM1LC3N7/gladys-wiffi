# Wiffi (stall.biz) pour Gladys

Cette intégration lit les capteurs des Wiffis de [stall.biz](https://www.stall.biz)
(weatherman, rainyman, airsniffer, wiffi-wz…) : température, humidité, pression,
luminosité, vent, pluie, en local, sans cloud et **en lecture seule**. Chaque Wiffi
envoie lui-même ses valeurs à Gladys, en télégrammes JSON.

Intégration non officielle, sans lien avec stall.biz. **Jamais testé avec un vrai
appareil** : elle suit la bibliothèque de référence `wiffi` 1.1.2 (utilisée par
Home Assistant) ; vos retours sont bienvenus.

## Comment ça marche

Gladys lance à côté de l’intégration un petit récepteur (`wiffi-push`) qui écoute
un port TCP choisi par Gladys. Le Wiffi ouvre une connexion vers ce port, envoie
un télégramme JSON terminé par l’octet 0x04, puis ferme. L’intégration lit le
télégramme, reconnaît le Wiffi par son adresse MAC et publie ses valeurs.

## Mise en place

1. Installez l’intégration, puis **enregistrez** sa configuration une première
   fois (même vide) : Gladys démarre le récepteur et choisit son port.
2. Rechargez l’écran de configuration : le port s’affiche dans la section
   « Réglez chaque Wiffi ».
3. Dans la page web de chaque Wiffi :
   - mettez l’adresse de la CCU (« CCU-IP ») à l’**adresse IP de la machine Gladys**
     sur votre réseau local (pas celle de Gladys Plus ni d’un proxy) ;
   - mettez le port des télégrammes JSON (paramètre `send_json`) au port affiché ;
   - choisissez l’envoi **JSON sans en-tête** (un télégramme précédé d’en-têtes HTTP
     est lu aussi).
4. Autorisez ce port dans le pare-feu de la machine Gladys s’il y en a un.
5. Après le premier télégramme, le Wiffi apparaît dans l’onglet **Découverte** :
   créez-le.

## Configuration

- **Expéditeurs autorisés** : les adresses IP de vos Wiffis (ou un réseau comme
  `192.168.1.0/24`, de /16 à /32), séparées par des virgules, 16 au plus. Vide :
  toute adresse privée de votre réseau local (10.x, 172.16-31.x, 192.168.x,
  169.254.x, IPv6 locales) est acceptée. Une liste invalide fait refuser **tous**
  les télégrammes jusqu’à correction (l’état indique le numéro de l’entrée fautive).
  Donnez à vos Wiffis une adresse IP fixe dans votre box. Selon la configuration
  réseau de Docker, le récepteur peut voir une autre adresse que celle du Wiffi :
  l’état affiche l’adresse refusée.
- **Muet après (minutes)** : de 2 à 60, 5 par défaut. Un Wiffi qui n’envoie rien
  pendant cette durée est affiché injoignable et nommé dans l’état ; un capteur
  sans valeur valable pendant cette durée (alors que son Wiffi parle) est nommé aussi.

## Ce qui est publié

| Unité du Wiffi                                                   | Dans Gladys                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `gradC`                                                          | température (°C), de -60 à 100                                 |
| `%` dont le nom contient « feucht » ou « humid » (sauf « abs »)  | humidité (%)                                                   |
| `%` dont le nom contient « boden » ou « soil »                   | humidité du sol (%)                                            |
| `mb`                                                             | pression (mbar), de 300 à 1200                                 |
| `lux`                                                            | luminosité (lux)                                               |
| `grad`                                                           | angle (°), de -90 à 360 (direction du vent, hauteur du soleil) |
| `km/h`, `m/s`                                                    | vitesse                                                        |
| `mm/h`                                                           | précipitations (mm/h)                                          |
| `mm` dont le nom contient « heute », « tag », « day » ou « 24 »  | précipitations du jour (mm/jour)                               |
| `mm` dont le nom contient « stunde », « hour », « 1h » ou « _h » | précipitations de l’heure (mm/h)                               |
| `ppm`                                                            | CO2 (ppm)                                                      |
| `ppb`                                                            | COV (ppb)                                                      |
| booléen dont le nom contient « regen » ou « rain »               | capteur de pluie                                               |
| booléen dont le nom contient « beweg », « motion » ou « pir »    | détecteur de mouvement                                         |
| texte (direction du vent en lettres…)                            | texte                                                          |

Rien n’est inventé :

- une valeur vide, `nan`, un texte, un nombre à virgule (« 1,5 ») ou hors de la plage
  de sa nature n’est **pas** publiée (jamais 0 à la place) ;
- une autre unité (`g/m3`…), un `mm` dont le nom ne dit ni le jour ni l’heure (ou
  dit la veille : « gestern ») ou un autre booléen n’est pas publié : l’état liste ces
  variables (les 20 premières), pour qu’on puisse les ajouter. Le `W/m2`
  (rayonnement) n’a pas de catégorie dans Gladys : jamais publié ;
- un Wiffi n’est gardé (et proposé dans la Découverte) qu’une fois qu’il a envoyé au
  moins une valeur publiable ;
- les détails réseau du Wiffi (adresse IP, SSID, signal Wi-Fi) ne sont pas publiés ;
- si l’unité d’une variable change, la fonction existante n’est plus alimentée et
  l’état le signale.

Une valeur reçue il y a plus d’une minute (par exemple gardée par le récepteur
pendant un redémarrage de l’intégration) est publiée avec sa date ; au-delà de 2 h,
elle n’est plus publiée. Un télégramme plus ancien que le dernier appliqué est ignoré.

## Limites du récepteur

Pour qu’un appareil défaillant ou malveillant du réseau ne puisse pas saturer
Gladys : une adresse non autorisée est coupée avant toute lecture ; un télégramme
est coupé au-delà de 64 Ko ; 16 connexions au plus (4 par adresse, la plus ancienne
de l’adresse cède la place) ; une connexion est fermée après 5 s sans octet et 15 s
au total, après 4 télégrammes (un vide compte) et au-delà de 129 Ko ; 60 télégrammes
par minute et par adresse (240 en tout, les vides comptent), le reste est ignoré.
Chaque refus est compté dans l’état pendant une heure. Quand Docker montre tous les
Wiffis sous une seule adresse (sa passerelle), ils se partagent les 60 par minute de
cette adresse : assez pour des Wiffis qui envoient toutes les quelques secondes, pas
pour des dizaines.

L’adresse MAC d’un télégramme ne prouve pas qui l’envoie : toute machine autorisée à
envoyer peut en annoncer une. Listez vos Wiffis dans « Expéditeurs autorisés ». La
table garde 32 Wiffis : pleine, le Wiffi non créé dans Gladys entendu il y a le plus
longtemps cède sa place (un Wiffi créé dans Gladys jamais), et un Wiffi jamais créé
ni entendu depuis un jour est oublié.

## Sécurité

Les télégrammes circulent en clair : n’exposez
jamais ce port sur Internet. L’intégration n’envoie rien aux Wiffis et ne les commande pas.

## Données conservées

`/data/wiffi.json` garde la liste des Wiffis, leurs fonctions et l’heure de leur
dernier télégramme (32 Wiffis et 150 fonctions par Wiffi au plus), jamais de valeur.
S’il est illisible, il n’est jamais réécrit et il est relu toutes les 10 s.
