import type {ApprovalReviewItem} from '@zhivex-ai/harness/application';
type CalendarChange = NonNullable<ApprovalReviewItem['calendarChange']>;
type CalendarCreation = NonNullable<ApprovalReviewItem['calendarCreation']>;
function EventValues({title, value}: {title: string; value: CalendarChange['before']}) {
  return <section aria-label={title}><h4>{title}</h4><dl>
    <dt>Title</dt><dd>{value.summary || '(Untitled event)'}</dd>
    <dt>Start (UTC)</dt><dd><time dateTime={value.start}>{new Date(value.start).toISOString()}</time></dd>
    <dt>End (UTC)</dt><dd><time dateTime={value.end}>{new Date(value.end).toISOString()}</time></dd>
  </dl></section>;
}
export function CalendarReview({change}: {change: CalendarChange | CalendarCreation}) {
  return <section className="calendar-change-review" aria-label={'before' in change ? 'Calendar change review' : 'Calendar creation review'}>
    <p>Calendar: {change.calendarId} · Account: {change.accountId}</p>
    <div className="calendar-review-grid">{'before' in change ? <EventValues title="Before" value={change.before} /> : null}<EventValues title={'before' in change ? 'After' : 'New event'} value={change.after} /></div>
    <h4>Attendees to notify ({change.attendees.length})</h4>
    {change.attendees.length ? <ul>{change.attendees.map((email, index) => <li key={`${index}:${email}`}>{email}</li>)}</ul> : <p>No attendees are listed for this event.</p>}
    <p>Approval requests calendar notifications to these attendees. It does not confirm that notifications were delivered.</p>
  </section>;
}
