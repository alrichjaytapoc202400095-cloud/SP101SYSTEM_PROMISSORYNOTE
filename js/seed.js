'use strict';

/* =========================================================
   Seed data for the Promissory Note System (demo dataset)
   Demo login: password = username for every account.
   ========================================================= */

const COURSES = [
  'BS Information Technology',
  'BS Computer Science',
  'BS Accountancy',
  'BS Education',
  'BS Nursing',
  'BSBA Marketing Management'
];

const YEARS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];

function seedData() {
  return {
    createdAt: new Date().toISOString(),
    counters: { pn: 1 }, // PN number counter → PN-2026-0001

    users: [
      { id: 'u-reg', role: 'registrar',  name: 'Maria Santos',     title: 'University Registrar',  username: 'registrar',  password: 'registrar'  },
      { id: 'u-acc', role: 'accounting', name: 'Pedro Cruz',       title: 'Accounting / Cashier',  username: 'accounting', password: 'accounting' },
      { id: 'u-adm', role: 'admin',      name: 'System Administrator', title: 'System Administrator (full power)', username: 'admin', password: 'admin' },

      // 80% paid → PN-eligible right away
      { id: 'u-s1', role: 'student', name: 'Ana Villanueva',     username: 'student1', password: 'student1',
        studentNo: '2022-00111', course: 'BS Information Technology', year: '2nd Year', tuition: 30000 },

      // 44% paid → below 75%, cannot file a PN yet
      { id: 'u-s2', role: 'student', name: 'John Robert Dizon',  username: 'student2', password: 'student2',
        studentNo: '2024-00208', course: 'BS Computer Science',       year: '1st Year', tuition: 27000 },

      // exactly 75% paid → eligible
      { id: 'u-s3', role: 'student', name: 'Cathy Alvarez',      username: 'student3', password: 'student3',
        studentNo: '2021-00317', course: 'BS Accountancy',            year: '3rd Year', tuition: 24000 },

      // fully paid → no PN needed, direct enrollment
      { id: 'u-s4', role: 'student', name: 'Marco Reyes',        username: 'student4', password: 'student4',
        studentNo: '2020-00042', course: 'BS Information Technology', year: '4th Year', tuition: 30000 }
    ],

    payments: [
      { id: 'p1', studentId: 'u-s1', amount: 13000, orNo: 'OR-1001', date: '2026-06-15', note: 'Down payment',            recordedBy: 'Pedro Cruz', recordedAt: '2026-06-15T09:00:00' },
      { id: 'p2', studentId: 'u-s1', amount: 11000, orNo: 'OR-1054', date: '2026-07-20', note: 'Partial payment',         recordedBy: 'Pedro Cruz', recordedAt: '2026-07-20T10:30:00' },
      { id: 'p3', studentId: 'u-s2', amount: 12000, orNo: 'OR-1012', date: '2026-06-18', note: 'Down payment',            recordedBy: 'Pedro Cruz', recordedAt: '2026-06-18T09:20:00' },
      { id: 'p4', studentId: 'u-s3', amount: 9000,  orNo: 'OR-1041', date: '2026-07-02', note: 'Down payment',            recordedBy: 'Pedro Cruz', recordedAt: '2026-07-02T08:45:00' },
      { id: 'p5', studentId: 'u-s3', amount: 9000,  orNo: 'OR-1077', date: '2026-08-14', note: '2nd installment',         recordedBy: 'Pedro Cruz', recordedAt: '2026-08-14T13:10:00' },
      { id: 'p6', studentId: 'u-s4', amount: 18000, orNo: 'OR-1050', date: '2026-07-10', note: '1st installment',         recordedBy: 'Pedro Cruz', recordedAt: '2026-07-10T11:00:00' },
      { id: 'p7', studentId: 'u-s4', amount: 12000, orNo: 'OR-1080', date: '2026-08-25', note: 'Final payment — fully paid', recordedBy: 'Pedro Cruz', recordedAt: '2026-08-25T15:40:00' }
    ],

    pns: [],           // promissory notes filed by students
    notifications: [], // in-app notifications (bell icon)
    enrollments: [],   // created lazily per student

    subjects: [
      { id: 'sub1', code: 'IT 101', name: 'Web Systems and Technologies',    units: 3, schedule: 'Mon/Thu 8:00–9:30 AM'  },
      { id: 'sub2', code: 'IT 102', name: 'Data Structures and Algorithms',  units: 3, schedule: 'Mon/Thu 9:30–11:00 AM' },
      { id: 'sub3', code: 'IT 103', name: 'Computer Networking 1',           units: 3, schedule: 'Tue/Fri 10:00–11:30 AM'},
      { id: 'sub4', code: 'IT 104', name: 'Database Management Systems',     units: 3, schedule: 'Mon/Thu 1:00–2:30 PM'  },
      { id: 'sub5', code: 'IT 105', name: 'Discrete Mathematics',            units: 3, schedule: 'Tue/Fri 1:00–2:30 PM'  },
      { id: 'sub6', code: 'GE 101', name: 'Purposive Communication',         units: 3, schedule: 'Tue/Fri 8:00–9:30 AM'  },
      { id: 'sub7', code: 'GE 102', name: 'Mathematics in the Modern World', units: 3, schedule: 'Wed 1:00–4:00 PM'      },
      { id: 'sub8', code: 'PE 101', name: 'Physical Education 3',            units: 2, schedule: 'Sat 7:00–9:00 AM'      }
    ]
  };
}
