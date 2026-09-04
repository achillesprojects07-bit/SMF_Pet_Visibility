import express from 'express';
import cors from 'cors';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import {authCode,validateFieldSession,fieldHome,storeDetail,saveDraft,submitStore,submitDay,uploadPhoto,mode} from './domain.js';

const app=express(),PORT=Number(process.env.PORT||8080),origin=process.env.ALLOWED_ORIGIN;
app.use(cors({origin:(o,cb)=>{if(!o||!origin||o===origin)return cb(null,true);cb(new Error('Origin not allowed'))},credentials:false}));
app.use(express.json({limit:'1mb'}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:12*1024*1024,files:1}});

function sign(user){if(!process.env.SESSION_SECRET)throw new Error('SESSION_SECRET not configured');return jwt.sign(user,process.env.SESSION_SECRET,{expiresIn:'12h',issuer:'smf-v5'})}
async function auth(req,res,next){
  try{
    const raw=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!raw)return res.status(401).json({error:'Sign in required.'});
    const decoded=jwt.verify(raw,process.env.SESSION_SECRET,{issuer:'smf-v5'});
    req.user=await validateFieldSession(decoded);
    next();
  }catch(e){res.status(Number(e.status||401)).json({error:e.message||'Session expired. Sign in again.'})}
}
const loginAttempts=new Map();
function loginAllowed(key){
  const now=Date.now(),windowMs=15*60*1000,max=8;
  const a=(loginAttempts.get(key)||[]).filter(t=>now-t<windowMs);
  if(a.length>=max){loginAttempts.set(key,a);return false}
  a.push(now);loginAttempts.set(key,a);return true;
}
function loginSuccess(key){loginAttempts.delete(key)}

app.get('/health',(_,res)=>res.json({ok:true,service:'smf-v5-api',mode:mode()}));
app.post('/v1/login',async(req,res,next)=>{
  const key=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'anon').split(',')[0].trim();
  if(!loginAllowed(key))return res.status(429).json({error:'Too many failed sign-in attempts. Please wait 15 minutes and try again.'});
  try{const user=await authCode(req.body?.code);loginSuccess(key);res.json({ok:true,token:sign(user),user,mode:mode()})}catch(e){next(e)}
});
app.get('/v1/field/home',auth,async(req,res,next)=>{try{const h=await fieldHome(req.user);res.json({ok:true,user:req.user,mode:mode(),stores:h.stores,dayStatus:h.dayStatus})}catch(e){next(e)}});
app.post('/v1/field/day/submit',auth,async(req,res,next)=>{try{res.json(await submitDay(req.user,req.body?.day))}catch(e){next(e)}});
app.get('/v1/field/store/:key',auth,async(req,res,next)=>{try{res.json({ok:true,...await storeDetail(req.user,req.params.key)})}catch(e){next(e)}});
app.post('/v1/field/store/save',auth,async(req,res,next)=>{try{res.json(await saveDraft(req.user,req.body||{}))}catch(e){next(e)}});
app.post('/v1/field/store/submit',auth,async(req,res,next)=>{try{res.json(await submitStore(req.user,req.body||{}))}catch(e){next(e)}});
app.post('/v1/field/photo',auth,upload.single('photo'),async(req,res,next)=>{try{res.json(await uploadPhoto(req.user,{...req.body,file:req.file}))}catch(e){next(e)}});
app.use((err,req,res,next)=>{console.error(err);res.status(Number(err.status||500)).json({error:err.message||'Server error'})});
app.listen(PORT,()=>console.log(`SMF v5 API listening on ${PORT}`));
