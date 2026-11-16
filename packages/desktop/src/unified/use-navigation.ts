import {useRef, useState} from 'react';
import {readNavigation, writeNavigation, type NavigationPage, type NavigationState} from './navigation.js';

/** Capture the project key in every setter: late callbacks cannot update another project's view. */
export function useNavigation(projectId?: string, area: 'assistant' | 'code' = 'assistant') {
  const views = useRef(new Map<string, NavigationState>());
  const [, redraw] = useState(0);
  const key = JSON.stringify([projectId, area]);
  if (!views.current.has(key)) views.current.set(key, projectId ? readNavigation(projectId, area) : {page: 'conversation', sessionId: ''});
  const current = views.current.get(key)!;
  const update = (patch: Partial<NavigationState>) => {
    const next = {...views.current.get(key)!, ...patch};
    views.current.set(key, next);
    if (projectId) writeNavigation(projectId, area, next);
    redraw(value => value + 1);
  };
  return {...current, setPage: (page: NavigationPage) => update({page}), setSessionId: (sessionId: string) => update({sessionId})};
}
