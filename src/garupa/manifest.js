import { validateResourceManifest } from '../resource-manifest.js';

const types = new Set(['garupa-motion', 'garupa-expression', 'garupa-expression-adapter']);

export function expandParameterManifest(config, configPath) {
  validateResourceManifest(config, configPath);
  const basePath = configPath.includes('/') ? configPath.slice(0, configPath.lastIndexOf('/')) : '';
  const seen = new Set();
  return config.components.flatMap((component, index) => {
    if (!types.has(component.type)) return [];
    const fail = message => { throw new Error(`${configPath} components[${index}]: ${message}`); };
    if (typeof component.name !== 'string' || !component.name.trim()) fail('name 必须为非空字符串');
    const adapter = component.type === 'garupa-expression-adapter';
    if (adapter && (typeof component.motionGroup !== 'string' || !component.motionGroup.trim())) fail('motionGroup 必须为非空字符串');
    const identity = `${component.type}:${adapter ? component.motionGroup : component.name}`;
    if (seen.has(identity)) fail(`重复资源 ${identity}`);
    seen.add(identity);
    const file = adapter ? component.script : component.src;
    if (typeof file !== 'string' || !file.trim() || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(file)
      || file.replaceAll('\\', '/').split('/').includes('..')) fail('必须使用包内相对路径');
    if (!adapter && !(component.type === 'garupa-motion' ? file.endsWith('.mtn') : file.endsWith('.exp.json'))) fail('源文件扩展名不符合资源类型');
    for (const key of ['fadeIn', 'fadeOut']) {
      if (component[key] !== undefined && !Number.isFinite(component[key])) fail(`${key} 必须为有限数值`);
    }
    return [{ key: `${configPath}#${index}`, name: component.name, description: component.description,
      type: component.type, src: component.src, basePath, component }];
  });
}

export function parameterResourceUrl(entry, packagesRoot) {
  const file = entry.component.script ?? entry.component.src;
  return `${packagesRoot}${entry.basePath ? `${entry.basePath}/` : ''}${file}`;
}

export class ExpressionAdapterRegistry {
  constructor(entries, packagesRoot, importModule = url => import(/* @vite-ignore */ url)) {
    this.entries = new Map(); this.packagesRoot = packagesRoot; this.importModule = importModule;
    this.modules = new Map();
    for (const entry of entries.filter(e => e.type === 'garupa-expression-adapter')) {
      const group = entry.component.motionGroup;
      if (this.entries.has(group)) throw new Error(`表情适配器 motionGroup 冲突: ${group}`);
      this.entries.set(group, entry);
    }
  }
  async factory(group) {
    const entry = this.entries.get(group);
    if (!entry) return null;
    if (!this.modules.has(group)) {
      const promise = this.importModule(parameterResourceUrl(entry, this.packagesRoot)).then(module => {
        if (typeof module.createExpressionAdapter !== 'function') throw new Error(`${entry.name}: 缺少 createExpressionAdapter`);
        return module.createExpressionAdapter;
      }).catch(error => { this.modules.delete(group); throw error; });
      this.modules.set(group, promise);
    }
    return this.modules.get(group);
  }
}
