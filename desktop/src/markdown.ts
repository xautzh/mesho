import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
const markdown = new MarkdownIt({html:false,breaks:true,linkify:false});
// Chat content must not load remote tracking images or active embedded content.
markdown.disable("image");
export function renderMarkdown(text:string, mentions:Record<string,string> = {}) {
  const html = DOMPurify.sanitize(markdown.render(text),{
    ALLOWED_TAGS:["p","br","strong","em","s","code","pre","blockquote","ul","ol","li","table","thead","tbody","tr","th","td","h1","h2","h3","h4","h5","h6","hr","a"],
    ALLOWED_ATTR:["href","title","start"],
    ALLOW_DATA_ATTR:false,
  });
  const holder=document.createElement("div"); holder.innerHTML=html;
  const walker=document.createTreeWalker(holder,NodeFilter.SHOW_TEXT);
  const nodes:Text[]=[]; while(walker.nextNode()) nodes.push(walker.currentNode as Text);
  for(const node of nodes){
    if(node.parentElement?.closest("code,pre,a")) continue;
    const value=node.data, pattern=/@([a-zA-Z0-9][a-zA-Z0-9_.-]{0,79})(?=\s|$)/g;
    let start=0,match:RegExpExecArray|null;const fragment=document.createDocumentFragment();
    while((match=pattern.exec(value))){
      if(!Object.hasOwn(mentions,match[1])) continue;
      fragment.append(document.createTextNode(value.slice(start,match.index)));
      const span=document.createElement("span");span.className="mention";span.textContent="@"+mentions[match[1]];fragment.append(span);start=match.index+match[0].length;
    }
    if(start){fragment.append(document.createTextNode(value.slice(start)));node.replaceWith(fragment);}
  }
  return holder.innerHTML;
}
