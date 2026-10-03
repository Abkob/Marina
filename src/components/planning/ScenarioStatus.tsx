import { scenarioMessage, type ScenarioState } from '../../../shared/planningState';
export function ScenarioStatus({state,conditional,assumptions=[],onRefresh}:{state:ScenarioState;conditional?:boolean;assumptions?:string[];onRefresh:()=>void}) {
  return <div role="status" className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
    <p>{scenarioMessage(state)}</p>
    {conditional && <p className="mt-1">Feasible only under the stated assumptions.</p>}
    {conditional && assumptions.length>0 && <ul className="mt-1 list-disc space-y-1 pl-4">{assumptions.map((text,index)=><li key={index}>{text}</li>)}</ul>}
    {['failed','partial','superseded','conflicted'].includes(state) && <button type="button" className="mt-1 min-h-11 rounded-lg px-2 text-xs hover:bg-slate-100 focus-visible:outline focus-visible:outline-indigo-500" onClick={onRefresh}>Refresh context</button>}
  </div>;
}
