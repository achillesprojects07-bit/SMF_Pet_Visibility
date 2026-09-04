import {google} from 'googleapis';
import {Readable} from 'node:stream';

const required=['BACKEND_SPREADSHEET_ID','POE_ROOT_FOLDER_ID','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN'];
for(const k of required){if(!process.env[k])console.warn(`[config] ${k} is not set`)}

const oauth=new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET);
oauth.setCredentials({refresh_token:process.env.GOOGLE_REFRESH_TOKEN});
export const sheets=google.sheets({version:'v4',auth:oauth});
export const drive=google.drive({version:'v3',auth:oauth});
export const spreadsheetId=process.env.BACKEND_SPREADSHEET_ID;

export async function sheetRows(tab){
  const r=await sheets.spreadsheets.values.get({spreadsheetId,range:`'${tab}'`});
  const values=r.data.values||[];
  if(!values.length)return {headers:[],rows:[]};
  const headers=values[0].map(String);
  return {headers,rows:values.slice(1).map((v,i)=>{
    const o={_row:i+2};headers.forEach((h,j)=>o[h]=v[j]??'');return o;
  })};
}
export async function appendObject(tab,obj){
  const {headers}=await sheetRows(tab);
  if(!headers.length)throw new Error(`Missing sheet/header: ${tab}`);
  await sheets.spreadsheets.values.append({
    spreadsheetId,range:`'${tab}'!A1:${col(headers.length)}1`,valueInputOption:'USER_ENTERED',insertDataOption:'INSERT_ROWS',
    requestBody:{values:[headers.map(h=>Object.prototype.hasOwnProperty.call(obj,h)?obj[h]:'')]}
  });
}
export async function updateObject(tab,row,obj){
  const {headers}=await sheetRows(tab);
  if(!headers.length)throw new Error(`Missing sheet/header: ${tab}`);
  const current=await sheets.spreadsheets.values.get({spreadsheetId,range:`'${tab}'!A${row}:${col(headers.length)}${row}`});
  const vals=(current.data.values?.[0]||[]);while(vals.length<headers.length)vals.push('');
  headers.forEach((h,i)=>{if(Object.prototype.hasOwnProperty.call(obj,h))vals[i]=obj[h]});
  await sheets.spreadsheets.values.update({
    spreadsheetId,range:`'${tab}'!A${row}:${col(headers.length)}${row}`,valueInputOption:'USER_ENTERED',
    requestBody:{values:[vals]}
  });
}
function col(n){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s}

export async function getFolder(id){const r=await drive.files.get({fileId:id,fields:'id,name,mimeType,trashed',supportsAllDrives:true});return r.data}
export async function findFolder(parentId,name){
  const q=`'${parentId.replace(/'/g,"\\'")}' in parents and name='${name.replace(/'/g,"\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r=await drive.files.list({q,fields:'files(id,name)',pageSize:10,supportsAllDrives:true,includeItemsFromAllDrives:true});
  return r.data.files?.[0]||null;
}
export async function ensureFolder(parentId,name){
  const existing=await findFolder(parentId,name);if(existing)return existing;
  const r=await drive.files.create({supportsAllDrives:true,fields:'id,name',requestBody:{name,mimeType:'application/vnd.google-apps.folder',parents:[parentId]}});
  return r.data;
}
export async function findFile(parentId,name){
  const q=`'${parentId.replace(/'/g,"\\'")}' in parents and name='${name.replace(/'/g,"\\'")}' and trashed=false`;
  const r=await drive.files.list({q,fields:'files(id,name,webViewLink)',pageSize:10,supportsAllDrives:true,includeItemsFromAllDrives:true});
  return r.data.files?.[0]||null;
}
export async function createFile(parentId,name,mimeType,buffer){
  const r=await drive.files.create({
    supportsAllDrives:true,fields:'id,name,webViewLink',
    requestBody:{name,parents:[parentId]},
    media:{mimeType:mimeType||'image/jpeg',body:Readable.from(buffer)}
  });
  return r.data;
}
export async function fileInfo(id){
  const r=await drive.files.get({fileId:id,fields:'id,name,webViewLink',supportsAllDrives:true});return r.data;
}
