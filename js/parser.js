/* parser.js — TXT 解码、章节切分与杂项清洗 */
"use strict";

const Parser = (() => {

  /* 编码识别：优先 UTF-8，失败回退 GBK（中文 TXT 常见） */
  function decode(buf) {
    let u8 = new Uint8Array(buf);
    if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) u8 = u8.subarray(3);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(u8);
    } catch (e) {
      try { return new TextDecoder("gbk").decode(u8); }
      catch (e2) { return new TextDecoder("utf-8").decode(u8); }
    }
  }

  function normalize(raw) {
    return raw
      .replace(/\r\n?/g, "\n")
      .replace(/[\u200b\ufeff\u00a0]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /* 章节标题行：如 第一章/第27节/楔子/序言/番外/Chapter 3 */
  const NUM = "[0-9０-９〇零一二三四五六七八九十百千万两\\-–—]+";
  const CHAPTER_RE = new RegExp(
    "^[ \\t\\u3000]*(?:" +
      "第\\s*" + NUM + "\\s*[章节回卷篇]" +
      "|序\\s*[章言曲]|楔\\s*子|引\\s*子|前\\s*言|后\\s*记|尾\\s*声|终\\s*章|大结局|本番完结|全本完结|完\\s*本\\s*感\\s*言" +
      "|番外(?:篇|随)?[^\\n]{0,12}" +
      "|Chapter\\s*\\d+" +
    ")[^\\n]{0,60}$", "mi");

  /* 常见的盗版站广告行（仅当整行较短时剔除） */
  const JUNK_RE = /本章未完|点击下一页|继续下一页|天才一秒|请记住|请收藏|笔趣阁|biqu|无弹窗|章节错误报告|txt下载|电子书下载|返回目录|加入书签|手机最新章节列表/i;

  function isJunkLine(line) {
    return line.length <= 42 && JUNK_RE.test(line) && !/^第.{0,12}[章节回]$/.test(line);
  }

  function cleanText(text) {
    return text.split("\n")
      .filter(line => !isJunkLine(line.trim()))
      .join("\n");
  }

  function splitFallback(text) {
    /* 未识别到章节：按约 3200 字分节 */
    const paras = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const chapters = [];
    let buf = [], len = 0;
    const flush = () => {
      if (buf.length) { chapters.push({ title: "第 " + (chapters.length + 1) + " 节", text: buf.join("\n\n") }); buf = []; len = 0; }
    };
    for (const p of paras) {
      buf.push(p); len += p.length;
      if (len >= 3200) flush();
    }
    flush();
    return chapters.length ? chapters : [{ title: "正文", text }];
  }

  /* 返回 { title, author, chapters:[{title, text}], chars } */
  function parse(raw, fallbackTitle) {
    let text = cleanText(normalize(raw));

    let author = "";
    const am = text.slice(0, 800).match(/作\s*者[ \t]*[：:]\s*([^\n]{1,24})/);
    if (am) author = am[1].trim();

    const chapters = [];
    const re = new RegExp(CHAPTER_RE.source, "gmi");
    let m; const marks = [];
    while ((m = re.exec(text)) !== null) {
      const line = m[0].trim();
      marks.push({
        start: m.index,
        end: m.index + m[0].length,
        title: line.length > 40 ? line.slice(0, 40) + "…" : line,
      });
    }

    if (marks.length >= 2) {
      const head = text.slice(0, marks[0].start).trim();
      if (head.length > 20) chapters.push({ title: "前言", text: head });
      for (let i = 0; i < marks.length; i++) {
        const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
        const body = text.slice(marks[i].end, end).trim();
        chapters.push({ title: marks[i].title, text: body });
      }
    } else {
      chapters.push(...splitFallback(text));
    }

    return {
      title: fallbackTitle || "无题",
      author,
      chapters,
      chars: chapters.reduce((n, c) => n + c.text.length + c.title.length, 0),
    };
  }

  function titleFromFilename(name) {
    let t = name.replace(/\.txt$/i, "").trim();
    const wrapped = t.match(/[《〈](.+?)[》〉]/);
    if (wrapped) t = wrapped[1];
    return t.replace(/[（(](?:精校|校对|完本|全文|完结|精校版)[^）)]*[）)]/g, "")
            .replace(/[\s_]*(完结|全文阅读|校对版|精校版)[\s_]*$/g, "")
            .trim() || name;
  }

  return { decode, parse, titleFromFilename };
})();
