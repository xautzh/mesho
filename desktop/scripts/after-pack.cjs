const fs = require('node:fs');
const {join} = require('node:path');
const PE = require('pe-library');
const ResEdit = require('resedit');
exports.default = async function(context) {
  if (context.electronPlatformName !== 'win32') return;
  const root = context.packager.projectDir;
  const file = join(context.appOutDir, 'Mesho.exe');
  const exe = PE.NtExecutable.from(fs.readFileSync(file), {ignoreCert:true});
  const resources = PE.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(join(root,'assets','icon.ico')));
  const groups = resources.entries.filter(entry => entry.type === 14).map(entry=>({id:entry.id,lang:entry.lang}));
  for(const group of groups.length ? groups : [{id:1,lang:1033}]) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries,group.id,group.lang,ico.icons.map(item=>item.data));
  }
  const versions=ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  const [major,minor,patch]=context.packager.appInfo.version.split('.').map(Number);
  for(const version of versions){
    version.setFileVersion(major,minor,patch,0,1033);
    version.setProductVersion(major,minor,patch,0,1033);
    version.setStringValues({lang:1033,codepage:1200},{FileDescription:'Mesho',ProductName:'Mesho',InternalName:'Mesho',OriginalFilename:'Mesho.exe'});
    version.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(exe);
  fs.writeFileSync(file,Buffer.from(exe.generate()));
};
