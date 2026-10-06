import {defineConfig} from '@playwright/test';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const require=createRequire(import.meta.url);
const vite=join(dirname(require.resolve('vite/package.json')),'bin/vite.js');
// Frontend-only checks. Every API request is intercepted with synthetic data.
export default defineConfig({
 testDir:'./e2e',testMatch:'nemotron-models.spec.ts',workers:1,retries:0,timeout:30000,
 reporter:[['list'],['json',{outputFile:'tmp/nemotron-browser/results.json'}]],
 use:{baseURL:'http://127.0.0.1:3117',channel:'chromium',trace:'retain-on-failure'},
 projects:[
  {name:'desktop',use:{viewport:{width:1440,height:900}}},
  {name:'tablet',use:{viewport:{width:768,height:1024},hasTouch:true}},
  {name:'phone',use:{viewport:{width:390,height:844},hasTouch:true,isMobile:true}},
  {name:'small-phone',use:{viewport:{width:320,height:568},hasTouch:true,isMobile:true}},
 ],
 webServer:{command:`"${process.execPath}" "${vite}" preview --port 3117 --host 127.0.0.1 --strictPort`,url:'http://127.0.0.1:3117',reuseExistingServer:false,timeout:30000},
});
