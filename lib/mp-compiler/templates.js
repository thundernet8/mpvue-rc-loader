const { getPathPrefix } = require('./util');

function genScript(name, isPage, src) {
    const prefix = isPage ? getPathPrefix(src) : './';

    return `
require('${prefix}static/js/manifest')
require('${prefix}static/js/vendor')
require('${prefix}static/js/${name}')
`;
}

function genStyle(name, isPage, src) {
    const prefix = isPage ? getPathPrefix(src) : './';
    return `@import "${prefix}static/css/${name}.wxss";`;
}

function genPageWxml(templateName, src) {
    return {
        wxmlContent: `<template is="${templateName}" data="{{ ...$root['0'], $root }}"/>`,
        importCode: `<import src="${templateName}" />`
    };
}

module.exports = { genScript, genStyle, genPageWxml };
