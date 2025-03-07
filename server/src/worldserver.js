import difference from "lodash-es/difference.js";
import forEach from "lodash-es/forEach.js";
import includes from "lodash-es/includes.js";
import isNumber from "lodash-es/isNumber.js";
import keys from "lodash-es/keys.js";
import map from "lodash-es/map.js";
import reject from "lodash-es/reject.js";
import size from "lodash-es/size.js";

import * as Types from "../../shared/js/gametypes.js";
import { Entities } from "../../shared/js/gametypes.js";

import Chest from "./chest.js";
import ChestArea from "./chestarea.js";
import Item from "./item.js";
import log from "./log.js";
import Map from "./map.js";
import {
    Population,
    Destroy,
    List,
    Spawn,
    Damage,
    Kill,
    Move,
    Blink,
} from "./message.js";
import Mob from "./mob.js";
import MobArea from "./mobarea.js";
import Npc from "./npc.js";
import Player from "./player.js";
import Properties from "./properties.js";
import * as Utils from "./utils.js";

// ======= GAME SERVER ========

// TODO: use JS Map data structures where appropriate instead of bare objects

export default class World {
    constructor(id, maxPlayers, websocketServer) {
        this.id = id;
        this.maxPlayers = maxPlayers;
        this.server = websocketServer;
        this.ups = 50;

        this.map = null;

        this.entities = {};
        this.players = {};
        this.mobs = {};
        this.attackers = {};
        this.items = {};
        this.equipping = {};
        this.hurt = {};
        this.npcs = {};
        this.mobAreas = [];
        this.chestAreas = [];
        this.groups = {};

        this.outgoingQueues = {};

        this.itemCount = 0;
        this.playerCount = 0;

        this.zoneGroupsReady = false;

        this.onPlayerConnect((player) => {
            player.onRequestPosition(() => {
                if (player.lastCheckpoint) {
                    return player.lastCheckpoint.getRandomPosition();
                } else {
                    return this.map.getRandomStartingPosition();
                }
            });
        });

        this.onPlayerEnter((player) => {
            log.info(`${player.name} has joined ${this.id}`);

            if (!player.hasEnteredGame) {
                this.incrementPlayerCount();
            }

            // Number of players in this world
            this.pushToPlayer(player, new Population(this.playerCount));
            this.pushRelevantEntityListTo(player);

            const move_callback = (x, y) => {
                log.debug(`${player.name} is moving to (${x}, ${y}).`);

                player.forEachAttacker((mob) => {
                    const target = this.getEntityById(mob.target);
                    if (target) {
                        const pos = this.findPositionNextTo(mob, target);
                        if (mob.distanceToSpawningPoint(pos.x, pos.y) > 50) {
                            mob.clearTarget();
                            mob.forgetEveryone();
                            player.removeAttacker(mob);
                        } else {
                            this.moveEntity(mob, pos.x, pos.y);
                        }
                    }
                });
            };

            player.onMove(move_callback);
            player.onLootMove(move_callback);

            player.onZone(() => {
                const hasChangedGroups =
                    this.handleEntityGroupMembership(player);

                if (hasChangedGroups) {
                    this.pushToPreviousGroups(player, new Destroy(player));
                    this.pushRelevantEntityListTo(player);
                }
            });

            player.onBroadcast((message, ignoreSelf) => {
                this.pushToAdjacentGroups(
                    player.group,
                    message,
                    ignoreSelf ? player.id : null,
                );
            });

            player.onBroadcastToZone((message, ignoreSelf) => {
                this.pushToGroup(
                    player.group,
                    message,
                    ignoreSelf ? player.id : null,
                );
            });

            player.onExit(() => {
                log.info(`${player.name} has left the game.`);
                this.removePlayer(player);
                this.decrementPlayerCount();

                if (this.removed_callback) {
                    this.removed_callback();
                }
            });

            if (this.added_callback) {
                this.added_callback();
            }
        });

        // Called when an entity is attacked by another entity
        this.onEntityAttack((attacker) => {
            const target = this.getEntityById(attacker.target);
            if (target && attacker.type === "mob") {
                const pos = this.findPositionNextTo(attacker, target);
                this.moveEntity(attacker, pos.x, pos.y);
            }
        });

        this.onRegenTick(() => {
            this.forEachCharacter((character) => {
                if (!character.hasFullHealth()) {
                    character.regenHealthBy(
                        Math.floor(character.maxHitPoints / 25),
                    );

                    if (character.type === "player") {
                        this.pushToPlayer(character, character.regen());
                    }
                }
            });
        });
    }

    run(mapFilePath) {
        this.map = new Map(mapFilePath);

        this.map.ready(() => {
            this.initZoneGroups();

            this.map.generateCollisionGrid();

            // Populate all mob "roaming" areas
            forEach(this.map.mobAreas, (a) => {
                const area = new MobArea(
                    a.id,
                    a.nb,
                    a.type,
                    a.x,
                    a.y,
                    a.width,
                    a.height,
                    this,
                );
                area.spawnMobs();
                area.onEmpty(this.handleEmptyMobArea.bind(this, area));

                this.mobAreas.push(area);
            });

            // Create all chest areas
            forEach(this.map.chestAreas, (a) => {
                const area = new ChestArea(
                    a.id,
                    a.x,
                    a.y,
                    a.w,
                    a.h,
                    a.tx,
                    a.ty,
                    a.i,
                    this,
                );
                this.chestAreas.push(area);
                area.onEmpty(this.handleEmptyChestArea.bind(this, area));
            });

            // Spawn static chests
            forEach(this.map.staticChests, (chest) => {
                const c = this.createChest(chest.x, chest.y, chest.i);
                this.addStaticItem(c);
            });

            // Spawn static entities
            this.spawnStaticEntities();

            // Set maximum number of entities contained in each chest area
            forEach(this.chestAreas, (area) => {
                area.setNumberOfEntities(area.entities.length);
            });
        });

        const regenCount = this.ups * 2;
        let updateCount = 0;
        setInterval(() => {
            this.processGroups();
            this.processQueues();

            if (updateCount < regenCount) {
                updateCount += 1;
            } else {
                if (this.regen_callback) {
                    this.regen_callback();
                }
                updateCount = 0;
            }
        }, 1000 / this.ups);

        log.info(`${this.id} created (capacity: ${this.maxPlayers} players).`);
    }

    setUpdatesPerSecond(ups) {
        this.ups = ups;
    }

    onInit(callback) {
        this.init_callback = callback;
    }

    onPlayerConnect(callback) {
        this.connect_callback = callback;
    }

    onPlayerEnter(callback) {
        this.enter_callback = callback;
    }

    onPlayerAdded(callback) {
        this.added_callback = callback;
    }

    onPlayerRemoved(callback) {
        this.removed_callback = callback;
    }

    onRegenTick(callback) {
        this.regen_callback = callback;
    }

    pushRelevantEntityListTo(player) {
        if (player && player.group in this.groups) {
            let entities = keys(this.groups[player.group].entities);
            entities = reject(entities, (id) => id == player.id);
            entities = map(entities, (id) => parseInt(id));
            if (entities) {
                this.pushToPlayer(player, new List(entities));
            }
        }
    }

    pushSpawnsToPlayer(player, ids) {
        forEach(ids, (id) => {
            const entity = this.getEntityById(id);
            if (entity) {
                this.pushToPlayer(player, new Spawn(entity));
            }
        });

        log.debug(`Pushed ${size(ids)} new spawns to ${player.id}`);
    }

    pushToPlayer(player, message) {
        if (player && player.id in this.outgoingQueues) {
            this.outgoingQueues[player.id].push(message.serialize());
        } else {
            log.error("pushToPlayer: player was undefined");
        }
    }

    pushToGroup(groupId, message, ignoredPlayer) {
        const group = this.groups[groupId];

        if (group) {
            forEach(group.players, (playerId) => {
                if (playerId != ignoredPlayer) {
                    this.pushToPlayer(this.getEntityById(playerId), message);
                }
            });
        } else {
            log.error(`groupId: ${groupId} is not a valid group`);
        }
    }

    pushToAdjacentGroups(groupId, message, ignoredPlayer) {
        this.map.forEachAdjacentGroup(groupId, (id) => {
            this.pushToGroup(id, message, ignoredPlayer);
        });
    }

    pushToPreviousGroups(player, message) {
        // Push this message to all groups which are not going to be updated anymore,
        // since the player left them.
        forEach(player.recentlyLeftGroups, (id) => {
            this.pushToGroup(id, message);
        });
        player.recentlyLeftGroups = [];
    }

    pushBroadcast(message, ignoredPlayer) {
        for (const id in this.outgoingQueues) {
            if (id != ignoredPlayer) {
                this.outgoingQueues[id].push(message.serialize());
            }
        }
    }

    processQueues() {
        for (const id in this.outgoingQueues) {
            if (this.outgoingQueues[id].length > 0) {
                const connection = this.server.getConnection(id);
                connection.send(this.outgoingQueues[id]);
                this.outgoingQueues[id] = [];
            }
        }
    }

    addEntity(entity) {
        this.entities[entity.id] = entity;
        this.handleEntityGroupMembership(entity);
    }

    removeEntity(entity) {
        if (entity.id in this.entities) {
            delete this.entities[entity.id];
        }
        if (entity.id in this.mobs) {
            delete this.mobs[entity.id];
        }
        if (entity.id in this.items) {
            delete this.items[entity.id];
        }

        if (entity.type === "mob") {
            this.clearMobAggroLink(entity);
            this.clearMobHateLinks(entity);
        }

        entity.destroy();
        this.removeFromGroups(entity);
        log.debug(
            "Removed " + Types.getKindAsString(entity.kind) + " : " + entity.id,
        );
    }

    addPlayer(player) {
        this.addEntity(player);
        this.players[player.id] = player;
        this.outgoingQueues[player.id] = [];

        //log.info("Added player : " + player.id);
    }

    removePlayer(player) {
        player.broadcast(player.despawn());
        this.removeEntity(player);
        delete this.players[player.id];
        delete this.outgoingQueues[player.id];
    }

    addMob(mob) {
        this.addEntity(mob);
        this.mobs[mob.id] = mob;
    }

    addNpc(kind, x, y) {
        const npc = new Npc(`8${x}${y}`, kind, x, y);
        this.addEntity(npc);
        this.npcs[npc.id] = npc;

        return npc;
    }

    addItem(item) {
        this.addEntity(item);
        this.items[item.id] = item;

        return item;
    }

    createItem(kind, x, y) {
        const id = `9${this.itemCount++}`;
        let item;

        if (kind === Entities.CHEST) {
            item = new Chest(id, x, y);
        } else {
            item = new Item(id, kind, x, y);
        }
        return item;
    }

    createChest(x, y, items) {
        const chest = this.createItem(Entities.CHEST, x, y);
        chest.setItems(items);
        return chest;
    }

    addStaticItem(item) {
        item.isStatic = true;
        item.onRespawn(this.addStaticItem.bind(this, item));

        return this.addItem(item);
    }

    addItemFromChest(kind, x, y) {
        const item = this.createItem(kind, x, y);
        item.isFromChest = true;

        return this.addItem(item);
    }

    /**
     * The mob will no longer be registered as an attacker of its current target.
     */
    clearMobAggroLink(mob) {
        if (mob.target) {
            const player = this.getEntityById(mob.target);
            if (player) {
                player.removeAttacker(mob);
            }
        }
    }

    clearMobHateLinks(mob) {
        if (mob) {
            forEach(mob.hatelist, (obj) => {
                const player = this.getEntityById(obj.id);
                if (player) {
                    player.removeHater(mob);
                }
            });
        }
    }

    forEachEntity(callback) {
        for (const id in this.entities) {
            callback(this.entities[id]);
        }
    }

    forEachPlayer(callback) {
        for (const id in this.players) {
            callback(this.players[id]);
        }
    }

    forEachMob(callback) {
        for (const id in this.mobs) {
            callback(this.mobs[id]);
        }
    }

    forEachCharacter(callback) {
        this.forEachPlayer(callback);
        this.forEachMob(callback);
    }

    handleMobHate(mobId, playerId, hatePoints) {
        const mob = this.getEntityById(mobId),
            player = this.getEntityById(playerId);

        if (player && mob) {
            mob.increaseHateFor(playerId, hatePoints);
            player.addHater(mob);

            if (mob.hitPoints > 0) {
                // only choose a target if still alive
                this.chooseMobTarget(mob);
            }
        }
    }

    chooseMobTarget(mob, hateRank) {
        const player = this.getEntityById(mob.getHatedPlayerId(hateRank));

        // If the mob is not already attacking the player, create an attack link between them.
        if (player && !(mob.id in player.attackers)) {
            this.clearMobAggroLink(mob);

            player.addAttacker(mob);
            mob.setTarget(player);

            this.broadcastAttacker(mob);
            log.debug(`${mob.id} is now attacking ${player.id}`);
        }
    }

    onEntityAttack(callback) {
        this.attack_callback = callback;
    }

    getEntityById(id) {
        if (id in this.entities) {
            return this.entities[id];
        } else {
            log.error(`Unknown entity : ${id}`);
        }
    }

    getPlayerCount() {
        let count = 0;
        for (const p in this.players) {
            if (Object.hasOwnProperty.call(this.players, p)) {
                count += 1;
            }
        }
        return count;
    }

    broadcastAttacker(character) {
        if (character) {
            this.pushToAdjacentGroups(
                character.group,
                character.attack(),
                character.id,
            );
        }
        if (this.attack_callback) {
            this.attack_callback(character);
        }
    }

    handleHurtEntity(entity, attacker, damage) {
        if (entity.type === "player") {
            // A player is only aware of his own hitpoints
            this.pushToPlayer(entity, entity.health());
        }

        if (entity.type === "mob") {
            // Let the mob's attacker (player) know how much damage was inflicted
            this.pushToPlayer(attacker, new Damage(entity, damage));
        }

        // If the entity is about to die
        if (entity.hitPoints <= 0) {
            if (entity.type === "mob") {
                const mob = entity,
                    item = this.getDroppedItem(mob);

                this.pushToPlayer(attacker, new Kill(mob));
                this.pushToAdjacentGroups(mob.group, mob.despawn()); // Despawn must be enqueued before the item drop
                if (item) {
                    this.pushToAdjacentGroups(mob.group, mob.drop(item));
                    this.handleItemDespawn(item);
                }
            }

            if (entity.type === "player") {
                this.handlePlayerVanish(entity);
                this.pushToAdjacentGroups(entity.group, entity.despawn());
            }

            this.removeEntity(entity);
        }
    }

    despawn(entity) {
        this.pushToAdjacentGroups(entity.group, entity.despawn());

        if (entity.id in this.entities) {
            this.removeEntity(entity);
        }
    }

    spawnStaticEntities() {
        let count = 0;

        forEach(this.map.staticEntities, (kindName, tid) => {
            const kind = Types.getKindFromString(kindName),
                pos = this.map.tileIndexToGridPosition(tid);

            if (Types.isNpc(kind)) {
                this.addNpc(kind, pos.x + 1, pos.y);
            }
            if (Types.isMob(kind)) {
                const mob = new Mob(
                    `7${kind}${count++}`,
                    kind,
                    pos.x + 1,
                    pos.y,
                );
                mob.onRespawn(() => {
                    mob.isDead = false;
                    this.addMob(mob);
                    if (mob.area && mob.area instanceof ChestArea) {
                        mob.area.addToArea(mob);
                    }
                });
                mob.onMove(this.onMobMoveCallback.bind(this));
                this.addMob(mob);
                this.tryAddingMobToChestArea(mob);
            }
            if (Types.isItem(kind)) {
                this.addStaticItem(this.createItem(kind, pos.x + 1, pos.y));
            }
        });
    }

    isValidPosition(x, y) {
        return (
            this.map &&
            isNumber(x) &&
            isNumber(y) &&
            !this.map.isOutOfBounds(x, y) &&
            !this.map.isColliding(x, y)
        );
    }

    handlePlayerVanish(player) {
        const previousAttackers = [];

        // When a player dies or teleports, all of his attackers go and attack their second most hated player.
        player.forEachAttacker((mob) => {
            previousAttackers.push(mob);
            this.chooseMobTarget(mob, 2);
        });

        forEach(previousAttackers, (mob) => {
            player.removeAttacker(mob);
            mob.clearTarget();
            mob.forgetPlayer(player.id, 1000);
        });

        this.handleEntityGroupMembership(player);
    }

    setPlayerCount(count) {
        this.playerCount = count;
    }

    incrementPlayerCount() {
        this.setPlayerCount(this.playerCount + 1);
    }

    decrementPlayerCount() {
        if (this.playerCount > 0) {
            this.setPlayerCount(this.playerCount - 1);
        }
    }

    getDroppedItem(mob) {
        const kind = Types.getKindAsString(mob.kind),
            drops = Properties[kind].drops,
            v = Utils.random(100);
        let p = 0,
            item;

        for (const itemName in drops) {
            const percentage = drops[itemName];

            p += percentage;
            if (v <= p) {
                item = this.addItem(
                    this.createItem(
                        Types.getKindFromString(itemName),
                        mob.x,
                        mob.y,
                    ),
                );
                break;
            }
        }

        return item;
    }

    onMobMoveCallback(mob) {
        this.pushToAdjacentGroups(mob.group, new Move(mob));
        this.handleEntityGroupMembership(mob);
    }

    findPositionNextTo(entity, target) {
        let valid = false,
            pos;

        while (!valid) {
            pos = entity.getPositionNextTo(target);
            valid = this.isValidPosition(pos.x, pos.y);
        }
        return pos;
    }

    initZoneGroups() {
        this.map.forEachGroup((id) => {
            this.groups[id] = {
                entities: {},
                players: [],
                incoming: [],
            };
        });
        this.zoneGroupsReady = true;
    }

    removeFromGroups(entity) {
        const oldGroups = [];

        if (entity && entity.group) {
            const group = this.groups[entity.group];
            if (entity instanceof Player) {
                group.players = reject(group.players, (id) => id === entity.id);
            }

            this.map.forEachAdjacentGroup(entity.group, (id) => {
                if (entity.id in this.groups[id].entities) {
                    delete this.groups[id].entities[entity.id];
                    oldGroups.push(id);
                }
            });
            entity.group = null;
        }
        return oldGroups;
    }

    /**
     * Registers an entity as "incoming" into several groups, meaning that it just entered them.
     * All players inside these groups will receive a Spawn message when WorldServer.processGroups is called.
     */
    addAsIncomingToGroup(entity, groupId) {
        const isChest = entity && entity instanceof Chest,
            isItem = entity && entity instanceof Item,
            isDroppedItem =
                entity && isItem && !entity.isStatic && !entity.isFromChest;

        if (entity && groupId) {
            this.map.forEachAdjacentGroup(groupId, (id) => {
                const group = this.groups[id];

                if (group) {
                    if (
                        !includes(group.entities, entity.id) &&
                        //  Items dropped off of mobs are handled differently via DROP messages. See handleHurtEntity.
                        (!isItem || isChest || (isItem && !isDroppedItem))
                    ) {
                        group.incoming.push(entity);
                    }
                }
            });
        }
    }

    addToGroup(entity, groupId) {
        const newGroups = [];

        if (entity && groupId && groupId in this.groups) {
            this.map.forEachAdjacentGroup(groupId, (id) => {
                this.groups[id].entities[entity.id] = entity;
                newGroups.push(id);
            });
            entity.group = groupId;

            if (entity instanceof Player) {
                this.groups[groupId].players.push(entity.id);
            }
        }
        return newGroups;
    }

    logGroupPlayers(groupId) {
        log.debug(`Players inside group ${groupId}:`);
        forEach(this.groups[groupId].players, (id) => {
            log.debug(`- player ${id}`);
        });
    }

    handleEntityGroupMembership(entity) {
        let hasChangedGroups = false;
        if (entity) {
            const groupId = this.map.getGroupIdFromPosition(entity.x, entity.y);
            if (!entity.group || (entity.group && entity.group !== groupId)) {
                hasChangedGroups = true;
                this.addAsIncomingToGroup(entity, groupId);
                const oldGroups = this.removeFromGroups(entity);
                const newGroups = this.addToGroup(entity, groupId);

                if (size(oldGroups) > 0) {
                    entity.recentlyLeftGroups = difference(
                        oldGroups,
                        newGroups,
                    );
                    log.debug(`group diff: ${entity.recentlyLeftGroups}`);
                }
            }
        }
        return hasChangedGroups;
    }

    processGroups() {
        if (this.zoneGroupsReady) {
            this.map.forEachGroup((id) => {
                if (this.groups[id].incoming.length > 0) {
                    forEach(this.groups[id].incoming, (entity) => {
                        if (entity instanceof Player) {
                            this.pushToGroup(id, new Spawn(entity), entity.id);
                        } else {
                            this.pushToGroup(id, new Spawn(entity));
                        }
                    });
                    this.groups[id].incoming = [];
                }
            });
        }
    }

    moveEntity(entity, x, y) {
        if (entity) {
            entity.setPosition(x, y);
            this.handleEntityGroupMembership(entity);
        }
    }

    handleItemDespawn(item) {
        if (item) {
            item.handleDespawn({
                beforeBlinkDelay: 10000,
                blinkCallback: () => {
                    this.pushToAdjacentGroups(item.group, new Blink(item));
                },
                blinkingDuration: 4000,
                despawnCallback: () => {
                    this.pushToAdjacentGroups(item.group, new Destroy(item));
                    this.removeEntity(item);
                },
            });
        }
    }

    handleEmptyMobArea(_area) {}

    handleEmptyChestArea(area) {
        if (area) {
            const chest = this.addItem(
                this.createChest(area.chestX, area.chestY, area.items),
            );
            this.handleItemDespawn(chest);
        }
    }

    handleOpenedChest(chest, _player) {
        this.pushToAdjacentGroups(chest.group, chest.despawn());
        this.removeEntity(chest);

        const kind = chest.getRandomItem();
        if (kind) {
            const item = this.addItemFromChest(kind, chest.x, chest.y);
            this.handleItemDespawn(item);
        }
    }

    tryAddingMobToChestArea(mob) {
        forEach(this.chestAreas, (area) => {
            if (area.contains(mob)) {
                area.addToArea(mob);
            }
        });
    }

    updatePopulation(totalPlayers) {
        this.pushBroadcast(
            new Population(
                this.playerCount,
                totalPlayers ? totalPlayers : this.playerCount,
            ),
        );
    }
}
