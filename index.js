const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const { get } = require('http');
const path = require('path');
require('dotenv').config()

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const ALERT_CHANNEL_ID = process.env.ALERT_CHANNEL_ID;
const DUMP_CHANNEL_ID = process.env.DUMP_CHANNEL_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

// Définition de la commande
const commands = [
    new SlashCommandBuilder()
        .setName('test')
        .setDescription('Renvoie un message de test'),
    new SlashCommandBuilder()
        .setName('average')
        .setDescription('Renvoi la moyenne des prix d\'un item')
        .addStringOption(option =>
            option.setName('nom_item')
                .setDescription('Le nom de l\'item')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('track')
        .setDescription('Nom de l\'item à suivre')
        .addStringOption(option =>
            option.setName('nom_item')
                .setDescription('Le nom de l\'item')
                .setRequired(true)),
    new SlashCommandBuilder()
        .setName('craft')
        .setDescription('Vérifier un craft d\'item')
        .addStringOption(option =>
            option.setName('nom_item')
                .setDescription('Nom de l\'item à fabriquer')
                .setRequired(true))
].map(command => command.toJSON());

// Enregistrement des commandes
const rest = new REST({ version: '10' }).setToken(TOKEN);
async function registerCommands() {
    try {
        console.log('Enregistrement des commandes...');
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('Commandes enregistrées avec succès.');
    } catch (error) {
        console.error(error);
    }
}

client.once('ready', () => {
    console.log(`Connecté en tant que ${client.user.tag}`);
});

let craftData = {};

// Gestion de l'interaction avec la commande
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'average') {
        await interaction.reply({ content: 'Traitement en cours...', ephemeral: true });

        const itemName = interaction.options.getString('nom_item');
        let itemID = "";

        try {

            if(!await hasItemID(itemName)) {
                await interaction.deleteReply();
                await interaction.followUp({ content: '❌ Erreur l\'item n\'existe pas.', ephemeral: true });
                return;
            }
            itemID = await getItemID(itemName);
            console.log(itemName);
            console.log(itemID);

            const moyenne = await getMoyenne(itemID);

            if(moyenne<=0) {
                await interaction.deleteReply();
                await interaction.followUp(`❌ Erreur l'item n'existe pas ou n'est pas lister dans le market.`);
                return;
            }

            // Création de l'embed
            const embed = new EmbedBuilder()
                .setTitle(itemName) // Titre = Nom de l'item
                .setDescription(`Prix Moyen : **${moyenne}** 💰`)
                .setColor(0x00AE86)
                .setThumbnail(`https://api.darkerdb.com/v1/icon?id=${itemID}`) // Image de l'item

            await interaction.deleteReply();

            // Envoyer la réponse de l'API dans Discord
            await interaction.followUp({ embeds: [embed] });
        } catch (error) {
            console.error('Erreur lors de la récupération des données:', error);
            await interaction.deleteReply();
            await interaction.followUp('❌ Erreur lors de la récupération des données.');
        }
    }

    if (interaction.commandName === 'craft') {
        const itemName = interaction.options.getString('nom_item');
        if(!hasItemID(itemName)) {
            await interaction.reply({ content: '❌ Erreur l\'item n\'existe pas.', ephemeral: true });
            return;
        }
        const itemID = await getItemID(itemName);
        const itemImage = await getItemImage(itemID);

        // Stocker les ingrédients pour ce craft
        craftData[interaction.user.id] = {
            itemName,
            itemImage,
            ingredients: [],
            messageId: null
        };

        // Création de l'embed
        const embed = new EmbedBuilder()
            .setTitle(`Craft de ${itemName}`)
            .setColor(0x00AE86)
            .setDescription("Ajoute des ingrédients avec 🛠 et valide avec ✅")
            .setThumbnail(itemImage);

        const message = await interaction.reply({ embeds: [embed], fetchReply: true });

        craftData[interaction.user.id].messageId = message.id;

        // Ajouter les réactions
        await message.react('🛠'); // Ajouter un ingrédient
        await message.react('✅'); // Valider le craft
    }

    if (interaction.commandName === 'track') {
        const itemName = interaction.options.getString('nom_item');
        if(!hasItemID(itemName)) {
            await interaction.reply({ content: '❌ Erreur l\'item n\'existe pas.', ephemeral: true });
            return;
        }
        const itemID = await getItemID(itemName);
        const itemImage = await getItemImage(itemID);

        saveTrackedItems([itemName]);

        // Création de l'embed
        const embed = new EmbedBuilder()
            .setTitle(`Suivis de ${itemName}`)
            .setColor(0x00AE86)
            .setThumbnail(itemImage);

        await interaction.reply({ embeds: [embed]});
    }
});

// Gestion des réactions
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;

    const userCraft = craftData[user.id];
    console.log(userCraft);
    if (!userCraft || reaction.message.id !== userCraft.messageId) return;

    if (reaction.emoji.name === '🛠') {
        reaction.users.remove(user.id)
        const filter = response => response.author.id === user.id;
        const botMessage = await reaction.message.channel.send(`${user}, entre l'ingrédient et sa quantité (ex: Bois 2) :`);

        const collector = reaction.message.channel.createMessageCollector({ filter, time: 30000, max: 1 });

        collector.on('collect', async collected => {
            const input = collected.content.split("-");
            if (input.length < 2 || isNaN(input[1])) {
                reaction.message.channel.send("Format invalide. Réessaye avec `Nom Quantité` (ex: Wolf Pelt -3).");
                return;
            }

            const ingredientName = input[0];
            const ingredientQuantity = parseInt(input[1]);

            if(!hasItemID(ingredientName)) {
                reaction.message.channel.send({ content: '❌ Erreur l\'item n\'existe pas.', ephemeral: true });
                return;
            }

            const ingredientID = getItemID(ingredientName);

            userCraft.ingredients.push({ name: ingredientName, quantity: ingredientQuantity });

            await collected.delete().catch(console.error);
            await botMessage.delete().catch(console.error);

            // Mettre à jour l'embed
            const embed = new EmbedBuilder()
                .setTitle(`Craft de ${userCraft.itemName}`)
                .setColor(0x00AE86)
                .setDescription("Ajoute des ingrédients avec 🛠 et valide avec ✅")
                .setThumbnail(userCraft.itemImage)
                .addFields(
                    userCraft.ingredients.map(ing => ({
                        name: ing.name,
                        value: `${ing.quantity}x`,
                        inline: true
                    }))
                );

            await reaction.message.edit({ embeds: [embed] });
        });
    }

    if (reaction.emoji.name === '✅') {
        await reaction.users.remove(user.id);
    
        if (userCraft.ingredients.length === 0) {
            await reaction.message.channel.send(`${user}, ajoute au moins un ingrédient avant de valider !`);
            return;
        }
    
        console.log("Debug : "+userCraft.itemName);
        const itemID = await getItemID(userCraft.itemName);
        const itemPrice = await getMoyenne(itemID); // Prix de l'item à craft
        let ingredientCost = 0;

        // Supprimer toutes les réactions de l'embed
        await reaction.message.reactions.removeAll().catch(console.error);

        // Afficher un embed temporaire en jaune pendant le calcul
        const tempEmbed = new EmbedBuilder()
            .setTitle(`⏳ Calcul en cours pour ${userCraft.itemName}...`)
            .setColor(0xFFD700) // Jaune
            .setDescription("Veuillez patienter, calcul des prix en cours...")
            .setThumbnail(userCraft.itemImage);

        await reaction.message.edit({ embeds: [tempEmbed] });

    
        // Utilisation de `for...of` pour attendre chaque appel async
        for (const ing of userCraft.ingredients) {
            const ingredientName = ing.name;
            const ingredientID = await getItemID(ingredientName);
            const ingredientPrice = await getMoyenne(ingredientID);
            ingredientCost += ing.quantity * ingredientPrice;
            console.log(`Prix de ${ingredientName} : ${ingredientPrice}`);
        }
    
        console.log(`Coût total des ingrédients : ${ingredientCost}`);
    
        // Générer l'embed final avec les coûts
        const embed = new EmbedBuilder()
            .setTitle(`Craft de ${userCraft.itemName}`)
            .setDescription(`Voici le coût du craft de **${userCraft.itemName}**`)
            .setThumbnail(userCraft.itemImage)
            .addFields(
                { name: "Prix de l'item", value: `${itemPrice} 💰`, inline: true },
                { name: "Coût des ingrédients", value: `${ingredientCost.toFixed(2)} 💰`, inline: true }
            );

        if (ingredientCost > itemPrice) {
            embed.setColor(0xFF0000)
        } else {
            embed.setColor(0x00FF00)
        }
    
        await reaction.message.edit({ embeds: [embed] });
    
        await reaction.message.channel.send(`${user}, craft validé !`);
        delete craftData[user.id]; // Nettoyer les données
    }    
});

const itemsFilePath = path.join(__dirname, 'items.json');
const trackedItemsFilePath = path.join(__dirname, 'trackedItems.json');

// Charger les items sauvegardés
function loadItems() {
    if (fs.existsSync(itemsFilePath)) {
        const data = fs.readFileSync(itemsFilePath);
        return JSON.parse(data);
    }
    return [];
}

// Sauvegarder les items
function saveItems(items) {
    fs.writeFileSync(itemsFilePath, JSON.stringify(items, null, 2));
}

// Charger les items suivis
function loadTrackedItems() {
    if (fs.existsSync(trackedItemsFilePath)) {
        const data = fs.readFileSync(trackedItemsFilePath);
        return JSON.parse(data);
    }
    return [];
}

// Sauvegarder les items suivis
function saveTrackedItems(items) {
    const existingItems = loadTrackedItems();
    const updatedItems = [...new Set([...existingItems, ...items])]; // Merge and remove duplicates
    fs.writeFileSync(trackedItemsFilePath, JSON.stringify(updatedItems, null, 2));
}

// Vérifier les nouveaux items mis en vente
async function checkNewItems() {
    const trackedItems = loadTrackedItems();
    const savedItems = loadItems();
    const newItems = [];

    for (const itemName of trackedItems) {
        const itemID = await getItemID(itemName);
        const API_URL = `https://api.darkerdb.com/v1/market?id=${itemID}&page=1`;
        const response = await fetch(API_URL);
        const data = await response.json();

        if (data.code === 200) {
            for (const item of data.body) {
                const existingItem = savedItems.find(savedItem => savedItem.id === item.id);
                if (!existingItem) {
                    newItems.push(item);
                    savedItems.push(item);
                }
            }
        }
    }

    if (newItems.length > 0) {
        saveItems(savedItems);
        let alertChannel;
        let dumpChannel
        try {
            alertChannel = await client.channels.fetch(ALERT_CHANNEL_ID);
            dumpChannel = await client.channels.fetch(DUMP_CHANNEL_ID);
        } catch (error) {
            console.error('Erreur lors de la récupération du canal:', error);
            return;
        }

        for (const item of newItems) {
            const profit = ((getCurrentAveragePrice(item.item) - item.price_per_unit) - getMarketFee((item.price / item.quantity))).toFixed(2);
            const embed = new EmbedBuilder()
                .setTitle(`Nouvel item en vente: ${item.item}`)
                .setDescription(`🤵 __**Vendeur:**__ ${item.seller}\n📦 __**Quantité:**__ ${item.quantity}\n💰 __**Prix:**__ ${item.price_per_unit}\n💰 __**Prix Moyen:**__ ${getCurrentAveragePrice(item.item)}\n💸 __**Taxe:**__ ${getMarketFee((item.price / item.quantity))}\n⏱️ __**Heure:**__ ${new Date(new Date(item.created_at).getTime() + 9 * 60 * 60 * 1000).toLocaleString()}\n\n🪙 __**Profit:**__ ${profit}`)
                .setThumbnail(`https://api.darkerdb.com/v1/icon?id=${await getItemID(item.item)}`);
            
            if(profit>0) {
                embed.setColor(0x00FF00)
                await alertChannel.send({ embeds: [embed] });
            } else {
                embed.setColor(0xFF0000);
            }
            await dumpChannel.send({ embeds: [embed] });
        }
    }
}

async function checkTrackedItemsPrice() {
    const trackedItems = loadTrackedItems();
    const itemAverages = {};

    for (const itemName of trackedItems) {
        if (await hasItemID(itemName)) {
            const itemID = await getItemID(itemName);
            console.log(itemID);
            const averagePrice = await getMoyennePageQuartile(await getMoyennePageInTable(itemID, 8));
            console.log(averagePrice);
            itemAverages[itemName] = averagePrice;
        }
    }
    
    fs.writeFileSync('itemAverages.json', JSON.stringify(itemAverages, null, 2));
};

// Appeler la fonction de vérification des nouveaux items toutes les 5 minutes
setInterval(checkTrackedItemsPrice, 30 * 1000);

setInterval(checkNewItems, 1 * 1000);

function isPriceLowerThanAverage(itemName, price) {
    const itemAverages = JSON.parse(fs.readFileSync('itemAverages.json', 'utf-8'));

    if (itemAverages.hasOwnProperty(itemName)) {
        const averagePrice = itemAverages[itemName];
        return price < averagePrice;
    }

    return;
}

function isPriceLowerThanAverageEmoji(itemName, price) {
    const itemAverages = JSON.parse(fs.readFileSync('itemAverages.json', 'utf-8'));

    if (itemAverages.hasOwnProperty(itemName)) {
        const averagePrice = itemAverages[itemName];
        if(price < averagePrice) {
            return `🟢`;
        } else {
            return `🔴`;
        }
    }

    return;
}

function getMarketFee(price) {
    if((price*0.05)<=15) {
        return 15;
    } else {
        return price*0.05;
    }
}

function getCurrentAveragePrice(itemName) {
    const itemAverages = JSON.parse(fs.readFileSync('itemAverages.json', 'utf-8'));
    const lowerCaseItemName = itemName.toLowerCase();

    if (itemAverages.hasOwnProperty(lowerCaseItemName)) {
        return itemAverages[lowerCaseItemName];
    }

    console.log(lowerCaseItemName)

    return "N/A";
}

async function getMoyenne(itemID) {
    let sum = 0;
    let count = 0;
    let i = 1;
    while(true) {
        const API_URL = `https://api.darkerdb.com/v1/market?id=${itemID}&page=${i}`;
        const response = await fetch(API_URL);
        const data = await response.json();

        if(data.code==404) {
            console.log("Nombre page: "+i)
            return (sum/count).toFixed(2);
        }

        for(let element of data.body) {
            sum += element.price_per_unit;
            count++;
            console.log(element.price_per_unit)
        }
        i++;
    }
}

async function getMoyennePage(itemID, page) {
    let sum = 0;
    let count = 0;
    let i = 1;

    if(page<=0) {
        page = 1;
    }

    while(page>0) {
        const API_URL = `https://api.darkerdb.com/v1/market?id=${itemID}&page=${i}`;
        const response = await fetch(API_URL);
        const data = await response.json();

        if(data.code==404) {
            console.log("Nombre page: "+i)
            return (sum/count).toFixed(2);
        }

        for(let element of data.body) {
            sum += element.price_per_unit;
            count++;
        }
        i++;
        page--;
    }
    return (sum/count).toFixed(2);
}

async function hasPage(itemID, page) {
    const API_URL = `https://api.darkerdb.com/v1/market?id=${itemID}&page=${page}`;
    const response = await fetch(API_URL);
    const data = await response.json();

    if(data.code==200) {
        return true;
    } else {
        return false;
    }
}

async function getItemID(itemName) {
    const API_URL = `https://api.darkerdb.com/v1/search?item=${itemName}`;
    const response = await fetch(API_URL);
    const data = await response.json();

    return data.body[0].id;
}

async function hasItemID(itemName) {
    const API_URL = `https://api.darkerdb.com/v1/search?item=${itemName}`;
    const response = await fetch(API_URL);
    const data = await response.json();

    if(data.code==200) {
        return true;
    } else {
        return false;
    }
}

async function getItemImage(itemID) {
    return `https://api.darkerdb.com/v1/icon?id=${itemID}`;
}

async function getMoyennePageInTable(itemID, page) {
    let sum = [];
    let count = 0;
    let i = 1;

    if(page<=0) {
        page = 1;
    }

    while(page>0) {
        const API_URL = `https://api.darkerdb.com/v1/market?id=${itemID}&page=${i}`;
        const response = await fetch(API_URL);
        const data = await response.json();

        if(data.code==404) {
            return sum;
        }

        for(let element of data.body) {
            sum.push((element.price_per_unit).toFixed(2));
            count++;
        }
        i++;
        page--;
    }
    return sum;
}

async function getMoyennePageQuartile(arr) {
    const min = await getQuartile(arr, 0.25);
    const max = await getQuartile(arr, 0.75);

    // Filtrer les valeurs aberrantes
    const filtered = arr.filter(price => price >= min && price <= max).map(Number);

    // Si aucun élément après filtrage, retourner null
    if (filtered.length === 0) return null;

    // Calculer la médiane sur les valeurs filtrées
    const mid = Math.floor(filtered.length / 2);
    return filtered.length % 2 === 0
        ? (Number(filtered[mid - 1]) + Number(filtered[mid])) / 2
        : Number(filtered[mid]);
}

async function getQuartile(arr, q) {
    if (!arr.length) return null; // Vérifier que la liste n'est pas vide

    // Trier les valeurs en ordre croissant
    arr.sort((a, b) => a - b);

    // Position du quartile
    const pos = (arr.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;

    // Si la position est un entier, on retourne la valeur
    if (arr[base + 1] !== undefined) {
        return arr[base] + rest * (arr[base + 1] - arr[base]); // Interpolation si nécessaire
    } else {
        return arr[base];
    }
}

// Connexion du bot
client.login(TOKEN).then(registerCommands).catch(console.error);
