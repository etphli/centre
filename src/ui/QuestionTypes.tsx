import { Check } from 'lucide-react';
import type { ResponseType } from '../../shared/schema';

export const responseTypes: { value:ResponseType;label:string }[] = [
  {value:'multiple_choice',label:'Multiple choice'},
  {value:'short_response',label:'Short response'},
  {value:'long_response',label:'Long response'},
];

export function QuestionTypes({ value,onChange,label,keepOne = false }: { value:ResponseType[];onChange:(value:ResponseType[])=>void;label:string;keepOne?:boolean }) {
  return <div className="question-types" role="group" aria-label={label}>{responseTypes.map(option => <button type="button" aria-pressed={value.includes(option.value)} key={option.value} onClick={() => { const next = value.includes(option.value) ? value.filter(type => type !== option.value) : [...value,option.value]; if (!keepOne || next.length) onChange(next); }}>{value.includes(option.value) ? <Check size={11} /> : <span className="question-types__empty" />}{option.label}</button>)}</div>;
}
