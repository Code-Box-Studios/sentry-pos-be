import { centavosToPesos, toCsv } from './csv';

describe('centavosToPesos', () => {
  it('renders centavos as two-decimal pesos without a currency symbol', () => {
    expect(centavosToPesos(125000)).toBe('1250.00');
    expect(centavosToPesos(5)).toBe('0.05');
    expect(centavosToPesos(0)).toBe('0.00');
  });

  it('renders a negative amount with a leading minus', () => {
    expect(centavosToPesos(-2550)).toBe('-25.50');
  });

  it('renders null as an empty field, never as zero', () => {
    expect(centavosToPesos(null)).toBe('');
  });
});

describe('toCsv', () => {
  it('starts with a BOM and separates rows with CRLF', () => {
    const csv = toCsv([{ columns: ['a', 'b'], rows: [[1, 2]] }]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿a,b\r\n1,2\r\n');
  });

  it('quotes fields containing a comma, a quote or a newline', () => {
    const csv = toCsv([
      {
        columns: ['name'],
        rows: [['Ay, caramba'], ['She said "hi"'], ['line\nbreak']],
      },
    ]);
    expect(csv).toContain('"Ay, caramba"');
    expect(csv).toContain('"She said ""hi"""');
    expect(csv).toContain('"line\nbreak"');
  });

  it('writes null as an empty field', () => {
    const csv = toCsv([{ columns: ['a', 'b'], rows: [[null, 1]] }]);
    expect(csv).toBe('﻿a,b\r\n,1\r\n');
  });

  it('separates multiple sections with a blank line and a title row', () => {
    const csv = toCsv([
      { title: 'By branch', columns: ['branch'], rows: [['Main']] },
      { title: 'By method', columns: ['method'], rows: [['cash']] },
    ]);
    expect(csv).toBe(
      '﻿By branch\r\nbranch\r\nMain\r\n\r\nBy method\r\nmethod\r\ncash\r\n',
    );
  });

  it('emits only headers for a section with no rows', () => {
    expect(toCsv([{ columns: ['a'], rows: [] }])).toBe('﻿a\r\n');
  });
});
