import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { observeRankingPaginationDOM } from "../app/ranking-pagination.mjs";

function node(tag, text = "", attrs = {}, children = [], visible = true) {
  const descendants = () => children.flatMap(child => [child, ...child.descendants()]);
  const result = {tagName:tag.toUpperCase(),innerText:text,descendants,
    getAttribute:name=>Object.hasOwn(attrs,name)?attrs[name]:null,
    hasAttribute:name=>Object.hasOwn(attrs,name),
    getClientRects:()=>visible?[{}]:[],
    contains:other=>descendants().includes(other),querySelectorAll:()=>descendants(),
    style:{display:"block",visibility:"visible",opacity:"1"}};
  Object.defineProperty(result,"value",{get(){throw Error("input values must not be read");}});
  return result;
}
function observe(nodes) {
  const all=nodes.flatMap(root=>[root,...root.descendants()]);
  const document={querySelectorAll:()=>all.filter(item=>
    /pagination/i.test(item.getAttribute("class")||"") ||
    (item.getAttribute("aria-label") && (item.tagName==="NAV" || item.getAttribute("role")==="navigation")))};
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${observeRankingPaginationDOM.toString()})()`,{
    document,getComputedStyle:element=>element.style,
  })));
}

test("observes numeric pages, current evidence, totals and disabled navigation without acting",()=>{
  const root=node("ul","",{class:"arco-pagination-list"},[
    node("li","",{class:"arco-pagination-item-prev arco-pagination-item-disabled","aria-label":"上一页"}),
    node("li","1",{class:"arco-pagination-item arco-pagination-item-active"}),
    node("li","2",{"aria-current":"false"}),
    node("li","…"),node("li","34"),
    node("button","",{"aria-label":"下一页",role:"button"}),
    node("span","共 1,000 条"),
  ]);
  const result=observe([root]);
  assert.equal(result.status,"observed");assert.equal(result.container_count,1);
  assert.deepEqual(result.visible_page_numbers,[1,2,34]);
  assert.deepEqual(result.current_page_candidates,[1]);
  assert.deepEqual(result.totals,[{value:1000,unit:"条"}]);
  assert.equal(result.containers[0].controls[0].disabled,true);
  assert.equal(result.containers[0].controls[0].kind,"previous");
  assert.equal(result.containers[0].controls[1].current_evidence,"class");
  assert.equal(result.containers[0].controls[5].kind,"next");
  assert.equal(result.truncated,false);
});

test("recognizes aria navigation, avoids duplicate nested containers and reports conflicting current candidates literally",()=>{
  const inner=node("div","",{class:"PaginationControls"},[
    node("a","3",{"aria-current":"page",href:"https://example.test/?token=PRIVATE"}),
    node("button","4",{class:"page-selected"}),node("span","Total 34 pages"),
  ]);
  const result=observe([node("nav","",{"aria-label":"Pagination Navigation"},[inner])]);
  assert.equal(result.container_count,1);
  assert.deepEqual(result.current_page_candidates,[3,4]);
  assert.deepEqual(result.totals,[{value:34,unit:"pages"}]);
  assert.equal(JSON.stringify(result).includes("PRIVATE"),false);
  assert.equal(JSON.stringify(result).includes("href"),false);
});

test("omits arbitrary account text, labels, input values and hidden nodes even inside semantic pagination",()=>{
  const input=node("input","",{"aria-label":"2",value:"PRIVATE_INPUT"});
  Object.defineProperty(input,"innerText",{get(){throw Error("input text must not be read");}});
  const hidden=node("button","99",{"aria-current":"page"},[],false);
  const transparent=node("button","98");transparent.style.opacity="0";
  const result=observe([node("div","PRIVATE_CONTAINER_FULL_TEXT",{class:"pagination"},[
    input,node("span","PRIVATE_ACCOUNT"),node("button","",{"aria-label":"PRIVATE_LABEL",title:"PRIVATE_TITLE"}),
    hidden,transparent,node("button","1",{"aria-current":"page","aria-disabled":"true"}),
  ])]);
  assert.equal(result.containers[0].controls.length,1);
  assert.deepEqual(result.visible_page_numbers,[1]);
  assert.equal(result.containers[0].controls[0].disabled,true);
  assert.equal(JSON.stringify(result).includes("PRIVATE"),false);
});

test("does not infer a pager from generic navigation, bare numbers or absent structures",()=>{
  for(const nodes of [[],[node("div","34")],[node("nav","",{"aria-label":"账号导航"},[node("span","1")])]]) {
    const result=observe(nodes);assert.equal(result.status,"unrecognized");assert.equal(result.container_count,0);
  }
  const result=observe([node("div","",{class:"pagination"})]);
  assert.equal(result.status,"unrecognized");assert.equal(result.container_count,1);
});

test("keeps unlabeled pagination arrow structure without inventing its action or accessible label",()=>{
  const result=observe([node("ul","",{class:"arco-pagination-list"},[
    node("li","",{class:"arco-pagination-item-next"}),
  ])]);
  assert.equal(result.containers[0].controls.length,1);
  const control=result.containers[0].controls[0];
  assert.equal(control.class,"arco-pagination-item-next");assert.equal(control.kind,"other");
  assert.equal(control.text,null);assert.equal(control.aria_label,null);
});

test("bounds container and control diagnostics and reports truncation rather than claiming full pagination",()=>{
  const roots=Array.from({length:6},()=>node("div","",{class:"pagination"},
    Array.from({length:70},(_,i)=>node("span",String(i+1)))));
  const result=observe(roots);
  assert.equal(result.containers.length,4);assert.equal(result.truncated,true);
  assert(result.containers.every(container=>container.controls.length===60));
  assert.equal(result.visible_page_numbers.at(-1),60);
});
