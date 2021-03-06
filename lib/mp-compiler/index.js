// for mp
const compiler = require('mpvue-template-compiler');
const { ConcatSource } = require('webpack-sources');

const babel = require('babel-core');
const path = require('path');
const fs = require('fs');
const deepEqual = require('deep-equal');

const { parseConfig, parseComponentsDeps, parseGlobalComponents, clearGlobalComponents } = require('./parse');
const { parseComponentsDeps: parseComponentsDepsTs } = require('./parse-ts');
const { genScript, genStyle, genPageWxml } = require('./templates');

const {
    cacheFileInfo,
    getFileInfo,
    getCompNameBySrc,
    resolveTarget,
    covertCCVar,
    cacheSlots,
    getSlots,
    getSlotsWithoutImports,
    htmlBeautify,
    getBabelrc,
    getPageSrc
} = require('./util');

let slotsHookAdded = false;
let emitQueue = {};
let emitHookAdded = false;

// 调用 compiler 生成 wxml
function genComponentWxml(compiled, options, emitFile, emitError, emitWarning) {
    options.components['slots'] = { src: 'slots', name: 'slots' };
    const x = compiler.compileToWxml(compiled, options);
    const { code: wxmlCodeStr, compiled: cp, slots, importCode } = x;
    const { mpErrors, mpTips } = cp;

    // 缓存 slots，延迟编译
    cacheSlots(slots, importCode);

    if (mpErrors && mpErrors.length) {
        emitError(`\n  Error compiling template:\n` + mpErrors.map(e => `  - ${e}`).join('\n') + '\n');
    }
    if (mpTips && mpTips.length) {
        emitWarning(mpTips.map(e => `  - ${e}`).join('\n') + '\n');
    }

    let str = wxmlCodeStr;
    if (importCode) {
        str = str.replace(importCode, '');
    }
    // return htmlBeautify(str);
    return {
        wxmlContent: htmlBeautify(str),
        importCode
    };
}

function createAppWxml(emitFile, resourcePath, rootComponent) {
    const { src, name } = getFileInfo(resourcePath) || {};
    const componentName = getCompNameBySrc(rootComponent);
    const { wxmlContent, importCode } = genPageWxml(componentName, src);
    const wxmlSrc = src;
    emitQueue[componentName + '_root'] = {
        isRoot: true,
        type: 'wxml',
        code: wxmlContent,
        path: `components/${name}/${name}`,
        name: componentName + '_root',
        importCode
    };
    // emitFile(`${wxmlSrc}.wxml`, wxmlContent)
}
// 更新全局组件时，需要重新生成wxml，用这个字段保存所有需要更新的页面及其参数
const cacheCreateWxmlFns = {};

function createWxml(emitWarning, emitError, emitFile, resourcePath, rootComponent, compiled, html) {
    cacheCreateWxmlFns[resourcePath] = arguments;
    const { pageType, moduleId, components } = getFileInfo(resourcePath) || {};

    // TODO, 这儿传 options 进去
    // {
    //   components: {
    //     'com-a': { src: '../../components/comA$hash', name: 'comA$hash' }
    //   },
    //   pageType: 'component',
    //   name: 'comA$hash',
    //   moduleId: 'moduleId'
    // }
    const name = getCompNameBySrc(resourcePath);
    const options = { components, pageType, name, moduleId };
    const { wxmlContent, importCode } = genComponentWxml(compiled, options, emitFile, emitError, emitWarning);
    const wxmlSrc = `components/${name}`;

    emitQueue[name] = {
        isRoot: false,
        type: 'wxml',
        code: wxmlContent,
        path: wxmlSrc,
        name,
        importCode
    };

    // emitFile(`${wxmlSrc}.wxml`, wxmlContent)
}

// 将入口组件以及其依赖的import template合并
function combineWxml(root) {
    const names = [];
    let hasSlots = false;
    const findImports = code => {
        if (!code) {
            return;
        }
        const matches = code.match(/<import src="([a-z0-9$]+)"/gi);
        if (matches && Array.isArray(matches)) {
            matches.forEach(m => {
                const name = m.match(/<import src="([a-z0-9$]+)"/i)[1];
                if (name === 'slots') {
                    hasSlots = true;
                }
                if (name && name !== 'slots' && !names.indexOf(name) > -1) {
                    names.push(name);
                    findImports(emitQueue[name].importCode);
                }
            });
        }
    };
    findImports(emitQueue[root].importCode);

    const tpls = Object.keys(emitQueue)
        .filter(k => !emitQueue[k].isRoot && names.indexOf(k) > -1)
        .reverse()
        .map(k => emitQueue[k])
        .reduce((prev, curr) => {
            return prev + curr.code + '\r\n';
        }, '');

    if (hasSlots) {
        const slots = getSlotsWithoutImports();
        return `<!-- slots -->\r\n${slots}\r\n<!-- templates -->\r\n${tpls}\r\n<!-- main -->\r\n${
            emitQueue[root].code
        }`;
    }

    return `<!-- templates -->\r\n${tpls}\r\n<!-- main -->\r\n${emitQueue[root].code}`;
}

// 编译出 wxml
function compileWxml(compiled, html) {
    if (!emitHookAdded) {
        emitHookAdded = true;
        this._compilation.plugin('seal', () => {
            const roots = Object.keys(emitQueue)
                .filter(k => emitQueue[k].isRoot)
                .map(k => emitQueue[k]);
            const slots = getSlotsWithoutImports();
            roots.forEach(root => {
                this.emitFile(`${root.path}.${root.type}`, combineWxml(root.name));
            });

            emitHookAdded = false;
        });
        this._compilation.plugin('after-optimize-chunk-assets', chunks => {
            const entries = Object.keys(this.options.entry).map(k => `components/${k}/${k}.js`);
            chunks.forEach(chunk => {
                chunk.files.forEach(file => {
                    if (entries.indexOf(file) > -1) {
                        this._compilation.assets[file] = new ConcatSource(
                            "require('../common/common.js');",
                            '\n',
                            this._compilation.assets[file]
                        );
                    }
                });
            });
        });
    }

    if (!slotsHookAdded) {
        // avoid add hook several times during compilation
        slotsHookAdded = true;
        // TODO: support webpack4
        this._compilation.plugin('seal', () => {
            // const tpls = Object.keys(emitQueue)
            //     .filter(k => !emitQueue[k].isRoot)
            //     .reverse()
            //     .map(k => emitQueue[k])
            //     .reduce((prev, curr) => {
            //         return prev + curr.code + '\r\n';
            //     }, '');
            // const content = getSlots();
            // console.log('slots', content);
            // const content = tpls;
            // if (content.trim()) {
            //     this.emitFile('components/slots.wxml', htmlBeautify(content));
            // }
            // reset flag after slots file emited
            slotsHookAdded = false;
        });
    }
    return new Promise(resolve => {
        const pollComponentsStatus = () => {
            const { pageType, components } = getFileInfo(this.resourcePath) || {};
            if (!pageType || (components && !components.isCompleted)) {
                setTimeout(pollComponentsStatus, 20);
            } else {
                resolve();
            }
        };
        pollComponentsStatus();
    }).then(() => {
        createWxml(this.emitWarning, this.emitError, this.emitFile, this.resourcePath, null, compiled, html);
    });
}

// 针对 .vue 单文件的脚本逻辑的处理
// 处理出当前单文件组件的子组件依赖
function compileMPScript(script, mpOptioins, moduleId) {
    const babelrc = getBabelrc(mpOptioins.globalBabelrc);
    let result, metadata;
    let scriptContent = script.content;
    const babelOptions = { extends: babelrc, plugins: [parseComponentsDeps] };
    if (script.src) {
        // 处理src
        const scriptpath = path.join(path.dirname(this.resourcePath), script.src);
        scriptContent = fs.readFileSync(scriptpath).toString();
    }
    if (script.lang === 'ts') {
        // 处理ts
        metadata = parseComponentsDepsTs(scriptContent);
    } else {
        result = babel.transform(scriptContent, babelOptions);
        metadata = result.metadata;
    }

    // metadata: importsMap, components
    const { importsMap, components: originComponents } = metadata;

    // 处理子组件的信息
    const components = {};
    const fileInfo = resolveTarget(this.resourcePath, this.options.entry);
    if (originComponents) {
        resolveSrc(originComponents, components, this.resolve, this.context)
            .then(() => {
                resolveComponent(this.resourcePath, fileInfo, importsMap, components, moduleId);
            })
            .catch(err => {
                console.error(err);
                resolveComponent(this.resourcePath, fileInfo, importsMap, components, moduleId);
            });
    } else {
        resolveComponent(this.resourcePath, fileInfo, importsMap, components, moduleId);
    }

    return script;
}

// checkMPEntry 针对 entry main.js 的入口处理
// 编译出 app, page 的入口js/wxml/json

const startPageReg = /^\^/;
let globalComponents;
function compileMP(content, mpOptioins) {
    const { resourcePath, emitFile, resolve, context, options } = this;

    const fileInfo = resolveTarget(resourcePath, options.entry);
    cacheFileInfo(resourcePath, fileInfo);
    const { src, name, isApp, isPage } = fileInfo;
    if (isApp) {
        // 解析前将可能存在的全局组件清空
        clearGlobalComponents();
    }

    const babelrc = getBabelrc(mpOptioins.globalBabelrc);
    // app入口进行全局component解析
    const { metadata } = babel.transform(content, {
        extends: babelrc,
        plugins: isApp ? [parseConfig, parseGlobalComponents] : [parseConfig]
    });

    // metadata: config
    const { config, rootComponent, globalComponents: globalComps } = metadata;

    if (isApp) {
        // 保存旧数据，用于对比
        const oldGlobalComponents = globalComponents;
        // 开始解析组件路径时把全局组件清空，解析完成后再进行赋值，标志全局组件解析完成
        globalComponents = null;

        // 解析全局组件的路径
        const components = {};
        resolveSrc(globalComps, components, resolve, context)
            .then(() => {
                handleResult(components);
            })
            .catch(err => {
                console.error(err);
                handleResult(components);
            });
        const handleResult = components => {
            globalComponents = components;
            // 热更时，如果全局组件更新，需要重新生成所有的wxml
            if (oldGlobalComponents && !deepEqual(oldGlobalComponents, globalComponents)) {
                // 更新所有页面的组件
                Object.keys(cacheResolveComponents).forEach(k => {
                    resolveComponent(...cacheResolveComponents[k]);
                });
                // 重新生成所有wxml
                Object.keys(cacheCreateWxmlFns).forEach(k => {
                    createWxml(...cacheCreateWxmlFns[k]);
                });
            }
        };
    }

    if (isApp || isPage) {
        // 生成入口 json
        if (config) {
            const configObj = config.value;

            // 只有 app 才处理 pages
            if (isApp) {
                const pages = Object.keys(options.entry)
                    .concat(configObj.pages)
                    .filter(v => v && v !== 'app')
                    .map(getPageSrc);

                // ^ 开头的放在第一个
                const startPageIndex = pages.findIndex(v => startPageReg.test(v));
                if (startPageIndex !== -1) {
                    const startPage = pages[startPageIndex].slice(1);
                    pages.splice(startPageIndex, 1);
                    pages.unshift(startPage);
                }
                configObj.pages = [...new Set(pages)];
            }
            emitFile(`${src}.json`, JSON.stringify(configObj, null, '  '));
        }

        // 生成入口 js
        // emitFile(`${src}.js`, genScript(name, isPage, src))

        // 生成入口 wxss
        // emitFile(`${src}.wxss`, genStyle(name, isPage, src))

        // 这儿应该异步在所有的模块都清晰后再生成
        // 生成入口 wxml
        if (isPage && rootComponent) {
            resolve(context, rootComponent, (err, rootComponentSrc) => {
                if (err) return;
                // 这儿需要搞定 根组件的 路径
                createAppWxml(emitFile, resourcePath, rootComponentSrc);
            });
        }
    }

    return content;
}

function compileMPComponent(content, mpOptions) {
    const { resourcePath, emitFile, resolve, context, options } = this;

    const fileInfo = resolveTarget(resourcePath, options.entry);
    cacheFileInfo(resourcePath, fileInfo);
    const { name, isApp, isPage } = fileInfo;
    const src = `components/${name}/${name}`;

    // const babelrc = getBabelrc(mpOptioins.globalBabelrc)
    // // app入口进行全局component解析
    // const { metadata } = babel.transform(content, { extends: babelrc, plugins: isApp ? [parseConfig, parseGlobalComponents] : [parseConfig] })

    // // metadata: config
    // const { config, rootComponent, globalComponents: globalComps } = metadata
    const configObj = {
        component: true
    };

    // 生成入口 json
    emitFile(`${src}.json`, JSON.stringify(configObj, null, '  '));

    // 生成入口 js
    // emitFile(`${src}.js`, genScript(name, isPage, src))

    // 生成入口 wxss
    // emitFile(`${src}.wxss`, genStyle(name, isPage, src))

    // 这儿应该异步在所有的模块都清晰后再生成
    // 生成入口 wxml
    resolve(context, resourcePath, (err, rootComponentSrc) => {
        if (err) return;
        // 这儿需要搞定 根组件的 路径
        createAppWxml(emitFile, resourcePath, rootComponentSrc);
    });

    return content;
}

function resolveSrc(originComponents, components, resolveFn, context) {
    return Promise.all(
        Object.keys(originComponents).map(k => {
            return new Promise((resolve, reject) => {
                resolveFn(context, originComponents[k], (err, realSrc) => {
                    if (err) return reject(err);
                    const com = covertCCVar(k);
                    const comName = getCompNameBySrc(realSrc);
                    components[com] = { src: comName, name: comName };
                    resolve();
                });
            });
        })
    );
}

const cacheResolveComponents = {};
function resolveComponent(resourcePath, fileInfo, importsMap, localComponents, moduleId) {
    // 需要等待全局组件解析完成
    // if (!globalComponents) {
    //   setTimeout(resolveComponent, 20, ...arguments)
    // } else {
    // 保存当前所有参数，在热更时如果全局组件发生变化，需要进行组件更新
    cacheResolveComponents[resourcePath] = arguments;
    const components = Object.assign({}, globalComponents, localComponents);
    components.isCompleted = true;
    cacheFileInfo(resourcePath, fileInfo, { importsMap, components, moduleId });
    // }
}

module.exports = { compileWxml, compileMPScript, compileMP, compileMPComponent };
