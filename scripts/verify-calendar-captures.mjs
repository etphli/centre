import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
const fixture = JSON.parse(await readFile('.runtime/calendar-fixture.json','utf8'));
for (const value of [fixture.url,fixture.controls]) { if(new URL(value).hostname !== '127.0.0.1') throw new Error('Calendar verification requires the disposable loopback fixture.'); }
await mkdir('.runtime/calendar-evidence',{recursive:true});
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});
const metrics=[];
try{
await page.goto(fixture.url);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Dark',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await page.getByRole('button',{name:'Calendar',exact:true}).click();
await page.locator('label.segmented__option').filter({hasText:'Week'}).click();await page.locator('.session').filter({hasText:'Algebra revision'}).click();
const r=await page.locator('.week').evaluate(e=>({width:e.clientWidth,scrollWidth:e.scrollWidth,scrollTop:e.scrollTop,days:[...e.querySelectorAll('.week__day')].map(d=>({left:d.getBoundingClientRect().left,right:d.getBoundingClientRect().right}))})); assert.equal(r.width,r.scrollWidth);assert.equal(r.days.length,7);assert.ok(r.scrollTop>0);metrics.push(r);
await page.waitForTimeout(350);await page.screenshot({path:'.runtime/calendar-evidence/week-dark-1280.png'});
assert.equal(await page.locator('.event-details__remove').evaluate(e=>getComputedStyle(e).color),'rgb(224, 138, 126)');
await page.getByRole('button',{name:'Edit or move',exact:true}).click();await page.getByRole('button',{name:'Date',exact:true}).click();await page.waitForTimeout(350);await page.screenshot({path:'.runtime/calendar-evidence/date-picker-dark.png'});await page.keyboard.press('ArrowRight');await page.keyboard.press('Escape');await page.getByRole('button',{name:'Cancel',exact:true}).click();
await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Light',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
await page.getByRole('button',{name:'Calendar',exact:true}).click();await page.locator('.session').filter({hasText:'Algebra revision'}).click();await page.waitForTimeout(350);await page.screenshot({path:'.runtime/calendar-evidence/week-light-1280.png'});
await page.getByRole('button',{name:'Edit or move',exact:true}).click();
assert.equal(await page.getByLabel('Planned duration hours',{exact:true}).evaluate(e=>getComputedStyle(e).appearance),'textfield');
await page.getByRole('combobox',{name:'Planned duration minutes',exact:true}).click();await page.waitForTimeout(350);await page.screenshot({path:'.runtime/calendar-evidence/duration-light.png'});await page.keyboard.press('Escape');await page.getByRole('button',{name:'Cancel',exact:true}).click();
await page.getByRole('button',{name:'Remove',exact:true}).click();await page.waitForTimeout(350);await page.screenshot({path:'.runtime/calendar-evidence/remove-light.png'});await page.getByRole('button',{name:'Keep session',exact:true}).click();
await page.locator('label.segmented__option').filter({hasText:'Month'}).click();await page.waitForTimeout(350);await page.screenshot({path:'.runtime/calendar-evidence/month-light-1280.png'});
const geometry=await page.locator('.month').evaluate(e=>({monthBottom:e.getBoundingClientRect().bottom,dockTop:document.querySelector('.dock').getBoundingClientRect().top}));assert.ok(geometry.monthBottom<=geometry.dockTop);metrics.push(geometry);
await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Dark',exact:true}).click();await page.getByRole('button',{name:'Calendar',exact:true}).click();await page.waitForTimeout(350);await page.screenshot({path:'.runtime/calendar-evidence/month-dark-1280.png'});
console.log(JSON.stringify({passed:true,metrics},null,2));
}finally{await browser.close();}
