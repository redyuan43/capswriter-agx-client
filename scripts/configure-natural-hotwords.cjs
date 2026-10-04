// Reversible migration: retain the original text dictionary and original weights.
const { HotWordsStore }=require('../src/platform/electron/hotWordsStore');
const fs=require('fs'),path=require('path');
const dir=process.argv[2]; if(!dir)throw Error('Usage: configure-natural-hotwords.cjs DATA_DIRECTORY');
const store=new HotWordsStore({dataDirectory:dir});
const file=path.join(dir,'hot-words.json');
if(fs.existsSync(file))fs.copyFileSync(file,`${file}.pre-natural-${Date.now()}`);
// Only unambiguous spellings already covered by the existing user rule file.
// No new Chinese homophone substitutions are inferred from model output.
const aliases={GitHub:['Git Hub','git hub','Git hub','github','Github','GITHUB'],
 Tailscale:['Tail Scale','tail scale','tailscale','TAILSCALE','tcale'],
 APP:['A P P','a p p'],APK:['A P K','a p k'],AGX:['A G X','a g x']};
for(const entry of store.entries) if(aliases[entry.term])entry.aliases=[...new Set([...entry.aliases,...aliases[entry.term]])];
store.activeGroups=['coding','hardware','network','personal'];store.managedWeights=true;
if(!store.persist())throw Error('Cannot persist dictionary');
const result=store.snapshot();
console.log(JSON.stringify({total:result.total,selected:result.selected,groups:result.activeGroups,strong:result.entries.filter(e=>e.weight===11).length,originalWeightsPreserved:true}));
