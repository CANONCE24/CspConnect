'use strict';
const defaults = require('../config/comment-rules.json');
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu,'').replace(/[\u200b-\u200d\ufeff]/g,'').toLowerCase();
const variants = { a:'a4@', b:'b8', e:'e3', i:'i1!|', l:'l1|', o:'o0', s:'s5$', t:'t7', u:'u' };
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function wordPattern(word) {
  const letters = [...normalize(word).replace(/\s/g,'')];
  const allowMask = !/\s/.test(word) && letters.length <= 12;
  const body = letters.map((letter,index) => '[' + escape((variants[letter] || letter) + (allowMask && index > 0 && index < letters.length - 1 ? '*' : '')) + ']').join('[\\s._*\\-]{0,2}');
  return new RegExp('(?<![\\p{L}\\p{N}])' + body + '(?![\\p{L}\\p{N}])','u');
}
function createCommentFilter(rules = defaults) {
  const groups = [
    ['profanity','Possible offensive language'],['harassment','Possible harassment or bullying'],
    ['hate','Possible discriminatory or hateful expression'],['spam','Possible promotional spam']
  ].map(([key,label]) => ({ label, patterns:(rules[key] || []).map(wordPattern) }));
  return function scan(body, recent = []) {
    const text = normalize(body), reasons = [];
    for (const group of groups) if (group.patterns.some(pattern => pattern.test(text))) reasons.push(group.label);
    const comparable = value => normalize(value).replace(/[^\p{L}\p{N}]/gu,'') || normalize(value).replace(/\s/g,'');
    if (recent.some(item => comparable(item.body) === comparable(body))) reasons.push('Repeated comment from the same student');
    if (/(\p{L}|\p{N})\1{11,}/u.test(text) || /\b([a-z]{3,})(?:[\s!,.-]+\1){4,}\b/u.test(text)) reasons.push('Possible repetitive spam');
    const links = text.match(/(?:https?:\/\/|www\.)[^\s<>]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|ph|xyz|top|click|zip|mov)(?:\/[^\s<>]*)?/gu) || [];
    if (links.length >= (rules.maximumLinks || 3)) reasons.push('Several links may indicate spam');
    let suspicious = /\b(?:javascript|data|file):/u.test(text);
    for (const candidate of links) {
      try {
        const url = new URL(/^https?:\/\//.test(candidate) ? candidate : 'https://' + candidate);
        const host = url.hostname.replace(/^www\./,'');
        if (url.username || url.password || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith('[') ||
          (rules.reviewDomains || []).some(domain => host === domain || host.endsWith('.' + domain)) ||
          (rules.reviewTlds || []).includes(host.split('.').at(-1)) || /\.(?:exe|scr|bat|cmd|apk)(?:$|\/)/i.test(url.pathname)) suspicious = true;
      } catch { suspicious = true; }
    }
    if (suspicious) reasons.push('Link needs a safety review');
    return { flagged:reasons.length > 0, reasons:[...new Set(reasons)] };
  };
}
module.exports = { createCommentFilter, normalize, scanComment:createCommentFilter() };
