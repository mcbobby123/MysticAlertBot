const WebSocket = require('ws');
const Discord = require('discord.js');
const fetch = require('node-fetch');
const fs = require('fs');
require('dotenv').config()

const client = new Discord.Client();

/**
 * @type {[()=>Discord.WebhookClient, (id: string, token: string)=>void}
 */
const [getHook, setHook] = (()=>{
  let hook = null;
  return [
    () => hook,
    (id, token) => hook = new Discord.WebhookClient(id, token),
  ]
})();

let PitMaster = {};
let Mystics = {};
const classes = {};
(async()=>{
  try{
    PitMaster = await fetch('https://pitpanda.rocks/pitreference').then(r=>r.json());
    Mystics = PitMaster.Pit.Mystics;
    for(const [key,enchant] of Object.entries(Mystics)){
      for(const cls of enchant.Classes){
        if(!classes[cls]) classes[cls] = [];
        classes[cls].push(key);
      }
    }
  }catch(e){
    console.error('Failed to fetch pit reference');
    console.error(e);
    process.exit(1);
  }
})();

/**
 * @typedef {Object} Filter
 * @property {string} name
 * @property {FilterPredicate} predicate
 */
/**
 * @typedef {(item: Item =>) boolean} FilterPredicate 
 */
/**
 * @typedef {Object} Enchant
 * @property {string} key
 * @property {number} level
 */
/**
 * @typedef {Object} Item
 * @property {string[]} flags
 * @property {string} _id
 * @property {Enchant[]} enchants
 * @property {number} maxLives
 * @property {number} nonce
 * @property {{id:number,name:string}} item
 * @property {string} lastseen
 * @property {number} lives
 * @property {string} owner
 * @property {number} tokens
 */

 /**
  * @param {boolean} a
  * @param {boolean} b
  */
const xor = (a,b) => Boolean(a^b);

 /**
  * @param {string} query
  * @returns {FilterPredicate} 
  */
const filterFromQueryStr = query => {
  /**
   * @type {FilterPredicate[]}
   */
  const pieces = query.toLowerCase().split(',').map(str => {
    /**
     * @type {(a: boolean) => boolean}
     */
    const maybeNot = (b => {
      if(b) str = str.substring(1);
      return (a) => xor(b, a);
    })(str.startsWith('!'));

    if(str.startsWith('uuid')) return item => maybeNot(item.owner === str.substring(4))
    const end = /-?[0-9]{1,}(\+|-)?$/.exec(str);
    if(end){
      const key = str.substring(0,end.index);
      /**
       * @type {Record<string, (t: number) => (n: number) => boolean>}
       */
      const directions = {'+':t => n => n >= t,'-':t => n => n <= t, '': t => n => t == n};
      const lastChar = (str[str.length - 1] in directions) ? str[str.length - 1] : '';
      const direction = directions[lastChar];
      const target = Number(str.substring(end.index, str.length - lastChar.length));
      const compare = direction(target);
      if(key === 'tokens') return item => maybeNot(compare(item.tokens));
      if(key === 'lives') return item => maybeNot(compare(item.lives));
      if(key === 'tier') return item => maybeNot(compare(item.tier));
      if(key === 'maxlives') return item => maybeNot(compare(item.maxLives));
      if(key === 'color') return item => maybeNot(compare(item.nonce % 5));
      if(key === 'nonce') return item => maybeNot(compare(item.nonce));
      if(key in classes) return item => maybeNot(item.enchants.some(ench => classes[key].includes(ench.key) && compare(ench.level)));
      return item => maybeNot(item.enchants.some(ench => ench.key === key && compare(ench.level)));
    }
    const typeMap = {
      bow: 261,
      sword: 283,
      pants: 300
    }
    if(str in typeMap) return item => maybeNot(item.item.id === typeMap[str]);
    return item => maybeNot(item.flags.includes(str));
  });
  
  return item => pieces.every(f => f(item));
}

const quickFilter = (str) => ({name:str,predicate:filterFromQueryStr(str)});

/**
 * @type {{enabled:boolean, filters:Filter[],webhook:{login:[string,string],location:string},alert:string}}
 */
const settings = (()=>{
  const raw = fs.existsSync('./settings.json') ? JSON.parse(fs.readFileSync('./settings.json')) : {
    enabled: false,
    filters: ['tokens0+'],
    alert: "use `ma setalert [alert]` to change this text",
  };
  raw.filters = raw.filters.map(quickFilter);
  if(raw.webhook) setHook(...raw.webhook.login);
  return raw;
})();

const connectSocket = () => {
  const socket = new WebSocket('wss://pitpanda.rocks/api/newmystics');

  socket.on('open', () => console.log('Connected to WebSocket!'));

  socket.on('message', data => {
    if(data === '3') return;
    if(!settings.enabled) return;
    const event = JSON.parse(data);
    const { tags, item } = event;
    console.log(event)
    if(!tags.includes('new')) return;
    const passes = settings.filters.filter(filter => filter.predicate(item));
    if(!passes.length) return;
    getHook().send(
      settings.alert,
      new Discord.MessageEmbed()
        .setTitle('New Mystic!')
        .setDescription(`Owner: https://pitpanda.rocks/players/${item.owner}\nPassed: ${passes.map(f=>`\`${f.name}\``).join(', ')}\n\`\`\`json\n${data}\`\`\``)
        .setImage(`https://pitpanda.rocks/api/images/item/${item._id}`)
        .setTimestamp()
    );
  });

  const interval = setInterval(() => socket.send('3'), 30e3);

  socket.on('close', () => {
    clearInterval(interval);
    setTimeout(connectSocket, 30e3);
  });
}

connectSocket();

const saveSettings = () => fs.writeFileSync('./settings.json', JSON.stringify({...settings, filters: settings.filters.map(f=>f.name)}))
saveSettings()
/**
 * @type {Record<string,(msg:Discord.Message,args:string[])=>void>}
 */
const commands = {
  setchannel: async (msg) => {
    if(!(msg.channel instanceof Discord.TextChannel)) return msg.reply('You can only do this in servers');
    if(settings.webhook){
      const guild = await msg.client.guilds.fetch(settings.webhook.location);
      const webhooks = await guild.fetchWebhooks();
      const target = webhooks.find(hook => hook.id === settings.webhook.login[0]);
      if(target){
        if(target.channelID === msg.channel.id) return await msg.reply('This channel was already set anyway');
        await target.delete();
      }
    }
    const channel = msg.channel;
    const newhook = await channel.createWebhook('MysticAlertBotHook');
    settings.webhook = {
      login: [newhook.id, newhook.token],
      location: msg.guild.id
    };
    setHook(newhook.id, newhook.token);
    saveSettings();
    await msg.reply('Channel has been set!');
  },
  enable: async msg => {
    if(!getHook()) return msg.reply('Set a webhook first!');
    settings.enabled = true;
    saveSettings();
    await msg.reply('Enabled!');
  },
  disable: async msg => {
    settings.enabled = false;
    saveSettings();
    await msg.reply('Disabled!');
  },
  add: async (msg, args) => {
    if(!args[0]) return await msg.reply('What filter tho');
    if(settings.filters.some(q => q.name === args[0])) return await msg.reply('Already added this filter!');
    settings.filters.push(quickFilter(args[0]));
    saveSettings();
    await msg.reply('Added!');
  },
  remove: async (msg, args) => {
    if(!args[0]) return await msg.reply('What filter tho');
    settings.filters = settings.filters.filter(q => q.name !== args[0])
    saveSettings();
    await msg.reply('Removed!');
  },
  setalert: async (msg, args) => {
    settings.alert = msg.content.substring(`ma setalert `.length);
    saveSettings();
    await msg.reply('Set!');
  },
  list: async (msg, args) => {
    const page = args[0] ? parseInt(args[0])-1 : 0;
    const list = settings.filters
      .slice(page*10,(page+1)*10)
      .map(filter => ` - \`${filter.name}\``)
      .join('\n')
    await msg.channel.send(`Queries (page ${page+1}/${Math.ceil(settings.filters.length/10)})\n${list}`)
  },
  help: async msg => await msg.reply(`Available commands are: ${Object.keys(commands).join(', ')}`),
}

client.on('message', async msg => {
  const args = msg.content.toLowerCase().split(/\s+/);
  if(args.shift() !== 'ma') return;
  if(args[0] in commands) await commands[args.shift()](msg, args);
});

client.on('ready', () => console.log(`Logged in as ${client.user.username}#${client.user.discriminator}`))

client.login(process.env.TOKEN);
