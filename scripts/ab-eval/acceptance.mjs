const safeToken=value=>Number.isSafeInteger(value)&&value>=0;

export const assessReplicatedAudit=({manifest,postflight})=>{
  const pairs=manifest?.pairs;
  const audited=postflight?.pairRows;
  const ineligible=reason=>({state:'REPLICATED_GATE_INELIGIBLE',reason});
  if(!Array.isArray(pairs)||pairs.length===0||!Array.isArray(audited)
    ||audited.length!==pairs.length||postflight?.schemaVersion!==1
    ||postflight.plannedPairs!==pairs.length
    ||postflight.completePairs!==pairs.length
    ||postflight.startedArms!==pairs.length*2
    ||postflight.settledArms!==pairs.length*2
    ||postflight.schedulerState!=='complete'
    ||!Array.isArray(postflight.issues))return ineligible('AUDIT_INCOMPLETE');
  const auditByPair=new Map();
  for(const row of audited){
    if(typeof row?.pairId!=='string'||auditByPair.has(row.pairId)
      ||row.complete!==true||typeof row.qualityPass!=='boolean'
      ||!safeToken(row.aRawTotal)||!safeToken(row.cRawTotal)
      ||row.tokenPass!==(row.cRawTotal<row.aRawTotal))
      return ineligible('AUDIT_PAIR_INVALID');
    auditByPair.set(row.pairId,row);
  }
  const grouped=new Map();
  let aRawTotal=0;let cRawTotal=0;let passingPairs=0;
  for(const pair of pairs){
    if(typeof pair?.taskId!=='string'||!auditByPair.has(pair.id))
      return ineligible('AUDIT_PAIR_MISMATCH');
    const row=auditByPair.get(pair.id);
    const group=grouped.get(pair.taskId)??{taskId:pair.taskId,pairIds:[],
      passingPairs:0,aRawTotal:0,cRawTotal:0};
    group.pairIds.push(pair.id);
    group.passingPairs+=Number(row.tokenPass);
    group.aRawTotal+=row.aRawTotal;
    group.cRawTotal+=row.cRawTotal;
    grouped.set(pair.taskId,group);
    passingPairs+=Number(row.tokenPass);
    aRawTotal+=row.aRawTotal;
    cRawTotal+=row.cRawTotal;
  }
  if([...grouped.values()].some(group=>group.pairIds.length!==3)
    ||!safeToken(aRawTotal)||!safeToken(cRawTotal))
    return ineligible('THREE_REPEATS_REQUIRED');
  const taskRows=[...grouped.values()].map(group=>({...group,
    majorityPass:group.passingPairs>=2}));
  const qualityPass=audited.every(row=>row.qualityPass)
    &&postflight.issues.length===0;
  const tokenPass=taskRows.every(row=>row.majorityPass)
    &&cRawTotal<aRawTotal;
  return {state:qualityPass&&tokenPass?'REPLICATED_GATE_PASS'
    :'REPLICATED_GATE_NOT_PASSED',qualityPass,tokenPass,
  plannedPairs:pairs.length,passingPairs,aRawTotal,cRawTotal,taskRows,
  issues:postflight.issues};
};
